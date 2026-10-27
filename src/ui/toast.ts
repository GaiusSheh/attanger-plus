import type { FluentMessageId } from "../../typings/i10n";
import type { CollectionAction, ItemAction, Summary, SummaryEntry } from "../sync/summary";
import { getPref } from "../utils/prefs";
import { collectionNames } from "../utils/zotero";
import { l10nID } from "./l10n";

/*
 * Notifications in the corner of the main window (requirements §F9), the
 * way Attanger shows its own: Zotero's progress window, one line per item
 * or collection, closing by itself after a few seconds or on a click.
 */

const TITLE = "Attanger Plus";
/** At most this many entries get a line of their own; the rest are counted. */
const MAX_LINES = 5;
const CLOSE_MS = 3_000;
const CLOSE_PROBLEM_MS = 5_000;

export interface ToastLine {
  /** Zotero item type icon name (e.g. "attachmentPDFLink"), "collection", or "" for none. */
  icon: string;
  text: string;
  problem?: boolean;
}

/** The plugin's own notification on screen; a new one replaces it, Attanger's stay. */
let current: Zotero.ProgressWindow | null = null;

function enabled(): boolean {
  return getPref("notify") !== false;
}

/** What one round of copy maintenance did; nothing when there is nothing to tell. */
export async function showSummary(summary: Summary): Promise<ToastLine[] | null> {
  if (!enabled()) {
    return null;
  }
  const lines = await describe(summary);
  if (!lines.length) {
    return null;
  }
  const headline = await text(summary.dryRun ? "toast-headline-dry-run" : "toast-headline");
  open(headline, lines, summary.problems ? CLOSE_PROBLEM_MS : CLOSE_MS);
  return lines;
}

/** Plain messages, e.g. what a window did once it closed. */
export function showMessages(messages: string[], problem = false): void {
  if (!enabled() || !messages.length) {
    return;
  }
  open(
    TITLE,
    messages.map((m) => ({ icon: "", text: m })),
    problem ? CLOSE_PROBLEM_MS : CLOSE_MS,
  );
}

/** The lines for a summary (exported for tests). */
export async function describe(summary: Summary): Promise<ToastLine[]> {
  const lines: ToastLine[] = [];
  let gone = 0;
  let more = 0;
  for (const entry of summary.entries) {
    const line = await lineOf(entry);
    if (!line) {
      // Erased in Zotero already: nothing left to name it by.
      gone++;
    } else if (lines.length < MAX_LINES) {
      lines.push(line);
    } else {
      more++;
    }
  }
  if (gone) {
    lines.push({ icon: "", text: await text("toast-gone", { count: gone }) });
  }
  if (more) {
    lines.push({ icon: "", text: await text("toast-more", { count: more }) });
  }
  if (summary.problems) {
    lines.push({ icon: "", text: await text("toast-problems", { count: summary.problems }), problem: true });
  }
  return lines;
}

const ITEM_ACTIONS: Record<ItemAction, FluentMessageId> = {
  copied: "toast-item-copied",
  deleted: "toast-item-deleted",
  renamed: "toast-item-renamed",
  trashed: "toast-item-trashed",
  restored: "toast-item-restored",
  purged: "toast-item-purged",
};

const COLLECTION_ACTIONS: Record<Exclude<CollectionAction, "moved">, FluentMessageId> = {
  trashed: "toast-collection-trashed",
  restored: "toast-collection-restored",
  purged: "toast-collection-purged",
};

async function lineOf(entry: SummaryEntry): Promise<ToastLine | null> {
  const libraryID = Zotero.Libraries.userLibraryID;
  const parts: string[] = [];
  if (entry.kind === "item") {
    const item = Zotero.Items.getByLibraryAndKey(libraryID, entry.itemKey) as Zotero.Item | false;
    if (!item) {
      return null;
    }
    for (const [action, count] of Object.entries(entry.actions) as [ItemAction, number][]) {
      parts.push(await text(ITEM_ACTIONS[action], { count }));
    }
    return { icon: item.getItemTypeIconName(), text: await text("toast-line", { title: item.getDisplayTitle(), actions: await join(parts) }) };
  }

  const collection = Zotero.Collections.getByLibraryAndKey(libraryID, entry.collectionKey) as Zotero.Collection | false;
  const folder = collection ? collectionNames(collection).join("/") : entry.folder;
  if (!folder) {
    return null;
  }
  for (const [action, count] of Object.entries(entry.actions) as [CollectionAction, number][]) {
    if (action === "moved") {
      parts.push(
        entry.movedFrom
          ? await text("toast-collection-moved", { from: entry.movedFrom })
          : await text("toast-collection-files-moved", { count }),
      );
    } else {
      parts.push(await text(COLLECTION_ACTIONS[action]));
    }
  }
  return { icon: "collection", text: await text("toast-line", { title: folder, actions: await join(parts) }) };
}

async function join(parts: string[]): Promise<string> {
  return parts.join(await text("toast-separator"));
}

/** Messages come from the main window's mainWindow.ftl: there may be no other window. */
async function text(id: FluentMessageId, args?: Record<string, string | number>): Promise<string> {
  const main = Zotero.getMainWindow();
  return (await main.document.l10n!.formatValue(l10nID(id), args)) as string;
}

function open(headline: string, lines: ToastLine[], closeMs: number): void {
  current?.close();
  const win = new Zotero.ProgressWindow({ closeOnClick: true });
  win.changeHeadline(headline);
  for (const line of lines) {
    if (!line.icon && !line.problem) {
      win.addDescription(line.text);
      continue;
    }
    const progress = new win.ItemProgress(line.icon === "collection" ? "" : line.icon, line.text);
    if (line.problem) {
      progress.setError();
      continue;
    }
    if (line.icon === "collection") {
      // The same icon Zotero shows for a collection in its own headlines.
      (progress as unknown as { setItemTypeAndIcon(type: string, cssIcon: string): void }).setItemTypeAndIcon("", "collection");
    }
    // Full opacity, as for a finished line in Zotero's own windows.
    progress.setProgress(100);
  }
  win.show();
  win.startCloseTimer(closeMs);
  current = win;
}

/** Close the plugin's notification (shutdown). */
export function closeToast(): void {
  current?.close();
  current = null;
}
