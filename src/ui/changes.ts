import type { FluentMessageId } from "../../typings/i10n";
import {
  findingID,
  importOp,
  replaceOps,
  type AllMissing,
  type CopiesDiffer,
  type CopyMissing,
  type Finding,
} from "../sync/changes";
import type { Intent, OpResult } from "../sync/types";
import { isDryRun } from "../utils/prefs";
import { l10nID } from "./l10n";
import { removeFromCollections } from "./remove";
import { showMessages } from "./toast";

/*
 * The summary window for changes made in the file manager (requirements
 * §F3.6–F3.8; Phase 2 plan, Q3): one row per finding, each with a choice
 * that starts at "handle manually" (or "ignore" for an ignored finding);
 * nothing is done until the user changes a choice and clicks "Apply".
 * "Ignore" only stops the automatic window: ignored findings are still
 * detected and listed here when the window is opened on request.
 */

const URL = "chrome://attangerplus/content/changes.xhtml";
/** Matches the windowtype attribute in changes.xhtml. */
const WINDOW_TYPE = "attanger-plus:changes";
const XHTML = "http://www.w3.org/1999/xhtml";

type L10nArgs = Record<string, string | number>;

export type Decision =
  | { kind: "restore"; itemKey: string; collectionID: number }
  | { kind: "remove"; itemKey: string; collectionID: number }
  | { kind: "sync"; finding: CopiesDiffer; from: string; to: string[] }
  | { kind: "relocate"; finding: AllMissing; source: string }
  | { kind: "trash-attachment"; attachmentKey: string }
  | { kind: "trash-item"; itemKey: string }
  | { kind: "ignore"; findingID: string }
  | { kind: "unignore"; findingID: string };

export interface Applied {
  dryRun: boolean;
  /** Copies made again in their collection folder. */
  restored: number;
  /** Collection memberships removed. */
  removed: number;
  /** Copies overwritten with the chosen version. */
  synced: number;
  /** Lost files brought back from a file the user picked. */
  relocated: number;
  /** Findings newly ignored. */
  ignored: number;
  /** Attachments or items moved to Zotero's trash. */
  trashed: number;
  /** Operations that were skipped or failed. */
  failed: OpResult[];
}

/**
 * Show the findings; an open window is replaced (its findings merged in, so
 * nothing reported earlier is lost). `done` resolves after "Apply", or to
 * null when the window is closed without it.
 */
export async function showChanges(
  findings: Finding[],
  options: { tellOutcome?: boolean } = {},
): Promise<{ win: Window; done: Promise<Applied | null> }> {
  const all = [...findings];
  for (const open of openWindows()) {
    for (const f of (open as WindowWithFindings).attangerPlusFindings ?? []) {
      if (!all.some((g) => findingID(g) === findingID(f))) {
        all.push(f);
      }
    }
    open.close();
  }
  const win = Zotero.getMainWindow().openDialog(URL, "", "chrome,centerscreen,dialog=no,resizable,width=780,height=600") as Window | null;
  if (!win) {
    throw new Error(`Could not open ${URL}`);
  }
  await new Promise<void>((resolve) => win.addEventListener("load", () => resolve(), { once: true }));
  (win as WindowWithFindings).attangerPlusFindings = all;
  const view = new ChangesView(win, all, options.tellOutcome ?? true);
  return { win, done: view.done };
}

export function closeChangesWindows(): void {
  for (const win of openWindows()) {
    win.close();
  }
}

/** Carry out the user's choices through the running plugin (logged, dry-run aware). */
export async function applyDecisions(decisions: Decision[]): Promise<Applied> {
  const sync = Zotero.AttangerPlus?.sync;
  if (!sync) {
    throw new Error("Attanger Plus is not running");
  }
  const applied: Applied = {
    dryRun: isDryRun(),
    restored: 0,
    removed: 0,
    synced: 0,
    relocated: 0,
    ignored: 0,
    trashed: 0,
    failed: [],
  };
  const collect = (results: OpResult[], op: string): number => {
    applied.failed.push(...results.filter((r) => r.status === "skipped" || r.status === "failed"));
    return results.filter((r) => r.operation.op === op && r.status === "done").length;
  };

  const ignore = decisions.flatMap((d) => (d.kind === "ignore" ? [d.findingID] : []));
  const unignore = decisions.flatMap((d) => (d.kind === "unignore" ? [d.findingID] : []));
  if (ignore.length) {
    await sync.setIgnored(ignore, true);
    applied.ignored = ignore.length;
  }
  if (unignore.length) {
    await sync.setIgnored(unignore, false);
  }

  // Syncs first: a restore copies from the copy Zotero points at, which a
  // sync may just have brought to the chosen version.
  for (const d of decisions) {
    if (d.kind === "sync") {
      applied.synced += collect(await sync.run(replaceOps(d.finding, d.from, d.to)), "replace");
      // Refresh the attachment record with the new content.
      await sync.reconcileNow(new Map([[d.finding.itemKey, {}]]));
    } else if (d.kind === "relocate") {
      const imported = collect(await sync.run([importOp(d.finding, d.source)]), "import");
      applied.relocated += imported;
      if (imported) {
        // The file is back where Zotero expects it; make the other copies.
        await sync.reconcileNow(new Map([[d.finding.itemKey, { fill: [d.finding.attachmentKey] }]]));
      }
    }
  }

  const restores = new Map<string, Intent>();
  for (const d of decisions) {
    if (d.kind === "restore") {
      const intent = restores.get(d.itemKey) ?? { addedTo: [] };
      intent.addedTo!.push(d.collectionID);
      restores.set(d.itemKey, intent);
    }
  }
  if (restores.size) {
    for (const r of await sync.reconcileNow(restores)) {
      applied.restored += collect(r.results, "copy");
    }
  }

  // F3.8: the lost file's attachment, or its whole item, to Zotero's trash
  // (restorable there). Like removal from a collection this is a change in
  // Zotero, not a file operation, so dry-run mode does not hold it back.
  const trash = decisions.flatMap((d) =>
    d.kind === "trash-attachment" ? [d.attachmentKey] : d.kind === "trash-item" ? [d.itemKey] : [],
  );
  if (trash.length) {
    const ids = trash
      .map((key) => Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key))
      .filter((i): i is Zotero.Item => !!i && !i.deleted)
      .map((i) => i.id);
    if (ids.length) {
      await Zotero.Items.trashTx(ids);
      applied.trashed = ids.length;
    }
  }

  const removals = decisions.filter((d) => d.kind === "remove");
  for (const d of removals) {
    const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, d.itemKey);
    if (item) {
      applied.removed += await removeFromCollections([item], [d.collectionID]);
    }
  }
  if (removals.length) {
    // The copies follow through the collection-item events.
    await sync.flush();
  }
  return applied;
}

interface WindowWithFindings extends Window {
  attangerPlusFindings?: Finding[];
}

interface FilePickerLike {
  modeOpen: number;
  returnOK: number;
  file: string;
  init(parent: Window, title: string, mode: number): void;
  show(): Promise<number>;
}

function openWindows(): Window[] {
  return [...(Services.wm.getEnumerator(WINDOW_TYPE) as unknown as Iterable<Window>)];
}

/** One row's choice: radio buttons, the first being the "nothing to do" default. */
interface Choice {
  container: HTMLElement;
  radios: HTMLInputElement[];
  value(): string;
}

class ChangesView {
  readonly done: Promise<Applied | null>;
  private readonly doc: Document;
  /** Reads the user's choices when "Apply" is clicked. */
  private readonly readers: (() => Decision | null)[] = [];

  constructor(
    private readonly win: Window,
    private readonly findings: Finding[],
    /** Show what was done after "Apply" (off in tests: the alert is modal). */
    private readonly notify: boolean,
  ) {
    this.doc = win.document;
    this.render();
    // "Apply" only once something is chosen; otherwise it would just close.
    const apply = this.element("apply") as HTMLButtonElement;
    const refresh = () => (apply.disabled = !this.readers.some((read) => read()));
    this.element("findings").addEventListener("change", refresh);
    refresh();
    this.done = new Promise((resolve) => {
      let answered = false;
      const answer = (value: Applied | null) => {
        if (!answered) {
          answered = true;
          resolve(value);
        }
      };
      this.element("close").addEventListener("click", () => {
        answer(null);
        win.close();
      });
      apply.addEventListener("click", () => {
        const decisions = this.readers.map((read) => read()).filter((d): d is Decision => !!d);
        apply.disabled = true;
        applyDecisions(decisions)
          .then(async (applied) => {
            win.close();
            answer(applied);
            if (this.notify) {
              await this.tellOutcome(applied, decisions.length);
            }
          })
          .catch((e) => {
            Zotero.logError(e);
            answer(null);
            win.close();
          });
      });
      win.addEventListener("unload", () => answer(null));
    });
  }

  private render(): void {
    const sections: [FluentMessageId, Finding["kind"]][] = [
      ["changes-section-differ", "copies-differ"],
      ["changes-section-missing", "copy-missing"],
      ["changes-section-all-missing", "all-missing"],
    ];
    const list = this.element("findings");
    for (const [heading, kind] of sections) {
      const ofKind = this.findings.filter((f) => f.kind === kind);
      if (!ofKind.length) {
        continue;
      }
      const section = this.create("section");
      const h2 = this.create("h2");
      this.localize(h2, heading, { count: ofKind.length });
      section.append(h2);
      for (const f of ofKind) {
        const row = f.kind === "copies-differ" ? this.differRow(f) : f.kind === "copy-missing" ? this.missingRow(f) : this.allMissingRow(f);
        // Text is localized asynchronously; these identify a row for tests and agents.
        row.dataset.kind = f.kind;
        row.dataset.attachmentKey = f.attachmentKey;
        section.append(row);
      }
      list.append(section);
    }
  }

  /** Row frame: the finding's text (marked when ignored) and its choice. */
  private row(f: Finding, textID: FluentMessageId, args: L10nArgs): { row: HTMLElement; text: HTMLElement } {
    const row = this.create("div");
    row.className = "finding";
    const text = this.create("p");
    const message = this.create("span");
    this.localize(message, textID, args);
    text.append(message);
    if (f.ignored) {
      const tag = this.create("span");
      tag.className = "ignored-tag";
      this.localize(tag, "changes-ignored-tag");
      text.append(" ", tag);
    }
    row.append(text);
    return { row, text };
  }

  /**
   * Radio buttons for a row; "manual" (or "ignore" for an ignored finding)
   * is selected at first, and only a change from it is a decision.
   */
  private choice(f: Finding, options: [string, FluentMessageId][], args: L10nArgs = {}): Choice {
    const container = this.create("div");
    container.className = "choices";
    const initial = f.ignored ? "ignore" : "manual";
    const radios = options.map(([value, id]) => {
      const label = this.create("label");
      const radio = this.create("input");
      radio.type = "radio";
      radio.name = `choice-${findingID(f)}`;
      radio.value = value;
      radio.checked = value === initial;
      const span = this.create("span");
      this.localize(span, id, args);
      label.append(radio, " ", span);
      container.append(label);
      return radio;
    });
    const value = () => radios.find((r) => r.checked)?.value ?? initial;
    // Ignoring and un-ignoring are decisions of their own.
    this.readers.push(() => {
      const v = value();
      if (v === initial) {
        return null;
      }
      if (v === "ignore") {
        return { kind: "ignore", findingID: findingID(f) };
      }
      return v === "manual" ? { kind: "unignore", findingID: findingID(f) } : null;
    });
    return { container, radios, value };
  }

  /** F3.6: pick the copy to keep (newest by default) and the copies to overwrite. */
  private differRow(f: CopiesDiffer): HTMLElement {
    const { row } = this.row(f, "changes-differ-item", { title: f.itemTitle, count: f.copies.length });
    const choice = this.choice(f, [
      ["manual", "changes-manual"],
      ["sync", "changes-differ-sync"],
      ["ignore", "changes-ignore"],
    ]);

    const table = this.create("table");
    const head = this.create("tr");
    for (const id of ["changes-col-source", "changes-col-target", "changes-col-file", "changes-col-modified", "changes-col-size"] as const) {
      const th = this.create("th");
      this.localize(th, id);
      head.append(th);
    }
    table.append(head);

    const newest = f.copies.reduce((a, b) => (b.mtime > a.mtime ? b : a));
    const rows = f.copies.map((copy) => {
      const tr = this.create("tr");
      const source = this.create("input");
      source.type = "radio";
      source.name = `source-${f.attachmentKey}`;
      source.value = copy.rel;
      source.checked = copy === newest;
      const target = this.create("input");
      target.type = "checkbox";
      target.className = "target";
      target.value = copy.rel;
      const cells = [source, target, copy.rel, new Date(copy.mtime).toLocaleString(), formatSize(copy.size)];
      for (const content of cells) {
        const td = this.create("td");
        td.append(content);
        tr.append(td);
      }
      table.append(tr);
      return { source, target };
    });
    // The table only applies to "sync"; the copy kept cannot also be overwritten.
    const update = () => {
      const syncing = choice.value() === "sync";
      for (const { source, target } of rows) {
        source.disabled = !syncing;
        target.disabled = source.checked || !syncing;
        if (source.checked) {
          target.checked = false;
        }
      }
    };
    for (const { source, target } of rows) {
      target.checked = !source.checked;
      source.addEventListener("change", () => {
        for (const other of rows) {
          other.target.checked = !other.source.checked;
        }
        update();
      });
    }
    // A radio only fires "change" when it becomes checked, so listen to all.
    for (const radio of choice.radios) {
      radio.addEventListener("change", update);
    }
    update();

    this.readers.push(() => {
      if (choice.value() !== "sync") {
        return null;
      }
      const from = rows.find((r) => r.source.checked)?.source.value;
      const to = rows.filter((r) => r.target.checked && !r.source.checked).map((r) => r.target.value);
      return from && to.length ? { kind: "sync", finding: f, from, to } : null;
    });
    row.append(choice.container, table);
    return row;
  }

  /** F3.7: handle it yourself, remove the item from that collection, restore the copy, or ignore. */
  private missingRow(f: CopyMissing): HTMLElement {
    const { row } = this.row(f, "changes-missing-item", {
      title: f.itemTitle,
      collection: f.collectionPath,
      file: f.path,
      source: f.source,
    });
    const choice = this.choice(
      f,
      [
        ["manual", "changes-manual"],
        ["remove", "changes-missing-remove"],
        ["restore", "changes-missing-restore"],
        ["ignore", "changes-ignore"],
      ],
      { collection: f.collectionPath },
    );
    this.readers.push(() => {
      const v = choice.value();
      return v === "remove" || v === "restore" ? { kind: v, itemKey: f.itemKey, collectionID: f.collectionID } : null;
    });
    row.append(choice.container);
    return row;
  }

  /**
   * F3.8: point to the lost file somewhere else, move the attachment (e.g. a
   * deliberately deleted arXiv version) or the whole item (no longer wanted)
   * to Zotero's trash, handle it yourself, or ignore.
   */
  private allMissingRow(f: AllMissing): HTMLElement {
    const { row } = this.row(f, "changes-all-missing-item", { title: f.itemTitle, file: f.path });
    const attachment = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, f.attachmentKey);
    const annotations = attachment ? attachment.getAnnotations().length : 0;
    // A standalone attachment is its own item: one trash choice.
    const standalone = f.itemKey === f.attachmentKey;
    const options: [string, FluentMessageId][] = [
      ["manual", "changes-manual"],
      ["relocate", "changes-relocate"],
      ...(standalone ? [] : ([["trash-attachment", "changes-trash-attachment"]] as [string, FluentMessageId][])),
      ["trash-item", "changes-trash-item"],
      ["ignore", "changes-ignore"],
    ];
    const choice = this.choice(f, options, { annotations });
    this.readers.push(() => {
      const v = choice.value();
      return v === "trash-attachment"
        ? { kind: "trash-attachment", attachmentKey: f.attachmentKey }
        : v === "trash-item"
          ? { kind: "trash-item", itemKey: f.itemKey }
          : null;
    });
    const picked = this.create("p");
    picked.className = "picked";
    let source: string | null = null;
    let previous = choice.value();
    for (const radio of choice.radios) {
      radio.addEventListener("change", () => {
        if (radio.value !== "relocate") {
          previous = radio.value;
          return;
        }
        this.pickFile(f)
          .then((path) => {
            if (path) {
              source = path;
              this.localize(picked, "changes-relocate-picked", { file: path });
            } else {
              // Cancelled: back to what was chosen before.
              choice.radios.find((r) => r.value === previous)!.checked = true;
            }
            this.element("findings").dispatchEvent(new this.win.Event("change"));
          })
          .catch((e) => Zotero.logError(e));
      });
    }
    this.readers.push(() =>
      choice.value() === "relocate" && source ? { kind: "relocate", finding: f, source } : null,
    );
    row.append(choice.container, picked);
    return row;
  }

  private async pickFile(f: AllMissing): Promise<string | null> {
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs") as {
      FilePicker: new () => FilePickerLike;
    };
    const fp = new FilePicker();
    const title = (await this.doc.l10n!.formatValue(l10nID("changes-relocate-title"), { title: f.itemTitle })) as string;
    fp.init(this.win, title, fp.modeOpen);
    return (await fp.show()) === fp.returnOK ? fp.file : null;
  }

  /** Say what was done; without it the window just closes and nothing seems to have happened. */
  private async tellOutcome(applied: Applied, chosen: number): Promise<void> {
    if (!chosen) {
      return;
    }
    const main = Zotero.getMainWindow();
    const format = (id: FluentMessageId, args?: L10nArgs) => main.document.l10n!.formatValue(l10nID(id), args) as Promise<string>;
    const notes: string[] = [
      await format("changes-done", {
        restored: applied.restored,
        removed: applied.removed,
        synced: applied.synced,
        relocated: applied.relocated,
        trashed: applied.trashed,
        ignored: applied.ignored,
      }),
    ];
    if (applied.dryRun) {
      notes.push(await format("changes-dry-run"));
    } else if (applied.failed.length) {
      notes.push(await format("changes-failed", { count: applied.failed.length }));
    }
    // In the corner, like the notifications after copy maintenance (§F9).
    showMessages(notes, !applied.dryRun && applied.failed.length > 0);
  }

  private element(id: string): HTMLElement {
    const el = this.doc.getElementById(id);
    if (!el) {
      throw new Error(`changes.xhtml has no #${id}`);
    }
    return el as HTMLElement;
  }

  private create<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    return this.doc.createElementNS(XHTML, tag) as HTMLElementTagNameMap[K];
  }

  private localize(el: Element, id: FluentMessageId, args?: L10nArgs): void {
    this.doc.l10n!.setAttributes(el, l10nID(id), args);
  }
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
