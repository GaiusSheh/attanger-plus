import type { FluentMessageId } from "../../typings/i10n";
import type { Unfiled } from "../sync/queue";
import { isDryRun } from "../utils/prefs";
import { collectionNames } from "../utils/zotero";
import { l10nID } from "./l10n";

/*
 * Items with files just removed from their last collection (requirements
 * §F3.3; Phase 3 plan, 3-3, Q2, Q3): one row each, three choices.
 * - cancel (the default, and what closing the window means): put the item
 *   back into the collections it was just removed from;
 * - trash the item: it goes back into those collections and then into
 *   Zotero's trash, so its copies all move to the plugin trash, and a
 *   restore brings item and files back where they were;
 * - keep the item, delete the files: its attachments go to Zotero's trash,
 *   and the copies in the folders it just left go to the plugin trash with
 *   them; the item stays in My Library, in no collection.
 * These are changes in Zotero, made also in dry-run mode; only the file
 * moves that follow are held back there.
 */

const URL = "chrome://attangerplus/content/unfiled.xhtml";
/** Matches the windowtype attribute in unfiled.xhtml. */
const WINDOW_TYPE = "attanger-plus:unfiled";
const XHTML = "http://www.w3.org/1999/xhtml";
const TITLE = "Attanger Plus";

export type UnfiledChoice = "cancel" | "trash-item" | "trash-files";

export interface UnfiledDecision {
  item: Unfiled;
  choice: UnfiledChoice;
}

export interface UnfiledApplied {
  dryRun: boolean;
  /** Items put back into their collections. */
  cancelled: number;
  /** Items moved to Zotero's trash. */
  trashedItems: number;
  /** Items whose attachments were moved to Zotero's trash. */
  trashedFiles: number;
}

interface UnfiledWindow extends Window {
  attangerPlusUnfiled?: Unfiled[];
  /** Closed without deciding: replaced by a new window, or Zotero shutting down. */
  attangerPlusSilentClose?: boolean;
}

/**
 * Ask about these items; an open window is replaced and its items merged
 * in. `done` resolves after "Apply" or after closing (everything cancelled).
 */
export async function showUnfiled(
  items: Unfiled[],
  options: { tellOutcome?: boolean } = {},
): Promise<{ win: Window; done: Promise<UnfiledApplied | null> }> {
  const all = [...items];
  for (const open of openWindows()) {
    for (const u of open.attangerPlusUnfiled ?? []) {
      if (!all.some((v) => v.itemKey === u.itemKey)) {
        all.push(u);
      }
    }
    open.attangerPlusSilentClose = true;
    open.close();
  }
  const win = Zotero.getMainWindow().openDialog(URL, "", "chrome,centerscreen,dialog=no,resizable,width=720,height=480") as UnfiledWindow | null;
  if (!win) {
    throw new Error(`Could not open ${URL}`);
  }
  await new Promise<void>((resolve) => win.addEventListener("load", () => resolve(), { once: true }));
  win.attangerPlusUnfiled = all;
  const view = new UnfiledView(win, all, options.tellOutcome ?? true);
  return { win, done: view.done };
}

/** At shutdown: close without deciding (the items stay in no collection; the check reports them as C1). */
export function closeUnfiledWindows(): void {
  for (const win of openWindows()) {
    win.attangerPlusSilentClose = true;
    win.close();
  }
}

/** Carry out the choices (see the comment at the top). */
export async function applyUnfiled(decisions: UnfiledDecision[]): Promise<UnfiledApplied> {
  const sync = Zotero.AttangerPlus?.sync;
  if (!sync) {
    throw new Error("Attanger Plus is not running");
  }
  const applied: UnfiledApplied = { dryRun: isDryRun(), cancelled: 0, trashedItems: 0, trashedFiles: 0 };
  const libraryID = Zotero.Libraries.userLibraryID;
  for (const { item: u, choice } of decisions) {
    const item = Zotero.Items.getByLibraryAndKey(libraryID, u.itemKey);
    if (!item || item.deleted) {
      continue;
    }
    // Collections that still exist; one deleted meanwhile cannot take the item back.
    const collections = liveCollections(u.removedFrom);
    if (choice === "cancel" || choice === "trash-item") {
      await Zotero.DB.executeTransaction(async () => {
        for (const id of collections) {
          item.addToCollection(id);
        }
        await item.save();
        if (choice === "trash-item") {
          await Zotero.Items.trash([item.id]);
        }
      });
      if (choice === "cancel") {
        applied.cancelled++;
      } else {
        applied.trashedItems++;
      }
    } else {
      const attachments = (Zotero.Items.get(item.getAttachments()) as Zotero.Item[]).filter(
        (a) => a.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE,
      );
      if (!attachments.length) {
        continue;
      }
      await Zotero.Items.trashTx(attachments.map((a) => a.id));
      // The trash events alone would not know the folders the item just left.
      await sync.reconcileNow(new Map([[item.key, { trash: true, formerCollections: collections }]]));
      applied.trashedFiles++;
    }
  }
  return applied;
}

function liveCollections(ids: number[]): number[] {
  return ids.filter((id) => {
    const c = Zotero.Collections.get(id) as Zotero.Collection | false;
    return !!c && !c.deleted;
  });
}

function openWindows(): UnfiledWindow[] {
  return [...(Services.wm.getEnumerator(WINDOW_TYPE) as unknown as Iterable<UnfiledWindow>)];
}

class UnfiledView {
  readonly done: Promise<UnfiledApplied | null>;
  private readonly doc: Document;
  private readonly readers: (() => UnfiledDecision)[] = [];

  constructor(
    private readonly win: UnfiledWindow,
    private readonly items: Unfiled[],
    /** Show what was done (off in tests: the alert is modal). */
    private readonly notify: boolean,
  ) {
    this.doc = win.document;
    this.render();
    this.done = new Promise((resolve) => {
      let answered = false;
      const run = (decisions: UnfiledDecision[]) => {
        if (answered) {
          return;
        }
        answered = true;
        applyUnfiled(decisions)
          .then(async (applied) => {
            resolve(applied);
            if (this.notify && decisions.some((d) => d.choice !== "cancel")) {
              await this.tellOutcome(applied);
            }
          })
          .catch((e) => {
            Zotero.logError(e);
            resolve(null);
          });
      };
      const cancelAll = () => run(this.items.map((item) => ({ item, choice: "cancel" as const })));
      this.element("apply").addEventListener("click", () => {
        const decisions = this.readers.map((read) => read());
        run(decisions);
        win.close();
      });
      this.element("cancel-all").addEventListener("click", () => {
        cancelAll();
        win.close();
      });
      // Closing means "cancel" (Q2), unless the window was replaced or Zotero is closing.
      win.addEventListener("unload", () => {
        if (win.attangerPlusSilentClose) {
          if (!answered) {
            answered = true;
            resolve(null);
          }
          return;
        }
        cancelAll();
      });
    });
  }

  private render(): void {
    const list = this.element("items");
    for (const u of this.items) {
      const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, u.itemKey);
      const attachments = item ? (Zotero.Items.get(item.getAttachments()) as Zotero.Item[]) : [];
      const files = attachments.filter((a) => a.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE);
      const annotations = files.reduce((n, a) => n + a.getAnnotations().length, 0);
      const collections = u.removedFrom
        .map((id) => Zotero.Collections.get(id) as Zotero.Collection | false)
        .map((c) => (c ? collectionNames(c).join("/") : "?"))
        .join("、");

      const row = this.create("div");
      row.className = "finding";
      // Text is localized asynchronously; this identifies a row for tests and agents.
      row.dataset.itemKey = u.itemKey;
      const text = this.create("p");
      this.localize(text, "unfiled-item", { title: u.itemTitle, collections, files: files.length });
      const choices = this.create("div");
      choices.className = "choices";
      const options: [UnfiledChoice, FluentMessageId][] = [
        ["cancel", "unfiled-cancel"],
        ["trash-item", "unfiled-trash-item"],
        ["trash-files", "unfiled-trash-files"],
      ];
      const radios = options.map(([value, id]) => {
        const label = this.create("label");
        const radio = this.create("input");
        radio.type = "radio";
        radio.name = `choice-${u.itemKey}`;
        radio.value = value;
        radio.checked = value === "cancel";
        const span = this.create("span");
        this.localize(span, id, { collections, annotations });
        label.append(radio, " ", span);
        choices.append(label);
        return radio;
      });
      this.readers.push(() => ({
        item: u,
        choice: (radios.find((r) => r.checked)?.value ?? "cancel") as UnfiledChoice,
      }));
      row.append(text, choices);
      list.append(row);
    }
  }

  /** Runs after this window has closed: its messages come from the main window's mainWindow.ftl. */
  private async tellOutcome(applied: UnfiledApplied): Promise<void> {
    const main = Zotero.getMainWindow();
    const format = (id: FluentMessageId, args?: Record<string, number>) =>
      main.document.l10n!.formatValue(l10nID(id), args) as Promise<string>;
    const notes = [
      await format("unfiled-done", {
        cancelled: applied.cancelled,
        trashedItems: applied.trashedItems,
        trashedFiles: applied.trashedFiles,
      }),
    ];
    if (applied.dryRun) {
      notes.push(await format("unfiled-dry-run"));
    }
    Services.prompt.alert(main as unknown as mozIDOMWindowProxy, TITLE, notes.join("\n\n"));
  }

  private element(id: string): HTMLElement {
    const el = this.doc.getElementById(id);
    if (!el) {
      throw new Error(`unfiled.xhtml has no #${id}`);
    }
    return el as HTMLElement;
  }

  private create<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    return this.doc.createElementNS(XHTML, tag) as HTMLElementTagNameMap[K];
  }

  private localize(el: Element, id: FluentMessageId, args?: Record<string, string | number>): void {
    this.doc.l10n!.setAttributes(el, l10nID(id), args);
  }
}
