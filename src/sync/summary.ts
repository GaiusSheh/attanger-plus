import type { Operation, OpResult } from "./types";

/*
 * What one round of copy maintenance did, for the notification after it
 * (requirements §F9): one entry per item or collection, with what was done
 * to its files. Bookkeeping (relinks, cleaning up emptied plugin trash
 * folders, temporary files) is left out; a round that only did such things,
 * or found everything in place, has nothing to tell.
 */

export type ItemAction = "copied" | "deleted" | "renamed" | "trashed" | "restored" | "purged";
export type CollectionAction = "moved" | "trashed" | "restored" | "purged";

export interface ItemEntry {
  kind: "item";
  itemKey: string;
  /** How many files each action touched, in the order first seen. */
  actions: Partial<Record<ItemAction, number>>;
}

export interface CollectionEntry {
  kind: "collection";
  collectionKey: string;
  actions: Partial<Record<CollectionAction, number>>;
  /** The folder it was moved from, when the whole folder moved at once. */
  movedFrom?: string;
  /** Its folder, for a collection Zotero no longer has (erased). */
  folder?: string;
}

export type SummaryEntry = ItemEntry | CollectionEntry;

export interface Summary {
  /** Dry-run mode: the actions were only planned and logged. */
  dryRun: boolean;
  entries: SummaryEntry[];
  /** Operations that were skipped or failed for a reason worth the user's look. */
  problems: number;
}

/**
 * Skips that are part of the design rather than trouble: an emptied-only
 * cleanup that found files left, a file a live item still uses (known_pits
 * A8), a trash folder whose owner came back.
 */
const ROUTINE_SKIPS = new Set(["not-empty", "in-use", "collection-exists", "item-alive"]);

/** Whether a result needs the user's look: failed, or skipped for other than a routine reason. */
export function isProblem(r: OpResult): boolean {
  return r.status === "failed" || (r.status === "skipped" && !ROUTINE_SKIPS.has(r.reason ?? ""));
}

export interface SummarizeOptions {
  /**
   * Collections just erased, by key, with their folders. Files moved out of
   * their plugin trash then go to a live item's other collection, which is
   * bookkeeping, not the collection coming back.
   */
  erased?: Map<string, string>;
}

export function summarize(results: OpResult[], options: SummarizeOptions = {}): Summary {
  const items = new Map<string, ItemEntry>();
  const collections = new Map<string, CollectionEntry>();
  const entries: SummaryEntry[] = [];
  let dryRun = false;
  let problems = 0;

  for (const r of results) {
    if (r.status === "skipped" || r.status === "failed") {
      if (isProblem(r)) {
        problems++;
      }
      continue;
    }
    if (r.status !== "done" && r.status !== "dry-run") {
      continue;
    }
    dryRun ||= r.status === "dry-run";
    const op = r.operation;
    const itemAction = itemActionOf(op);
    if (itemAction && "itemKey" in op) {
      let entry = items.get(op.itemKey);
      if (!entry) {
        entry = { kind: "item", itemKey: op.itemKey, actions: {} };
        items.set(op.itemKey, entry);
        entries.push(entry);
      }
      entry.actions[itemAction] = (entry.actions[itemAction] ?? 0) + 1;
      continue;
    }
    const erasedFolder = "collectionKey" in op ? options.erased?.get(op.collectionKey) : undefined;
    const collectionAction = erasedFolder !== undefined && op.op === "untrash-collection" ? null : collectionActionOf(op);
    if (collectionAction && "collectionKey" in op) {
      let entry = collections.get(op.collectionKey);
      if (!entry) {
        entry = { kind: "collection", collectionKey: op.collectionKey, actions: {} };
        if (erasedFolder !== undefined) {
          entry.folder = erasedFolder;
        }
        collections.set(op.collectionKey, entry);
        entries.push(entry);
      }
      entry.actions[collectionAction] = (entry.actions[collectionAction] ?? 0) + 1;
      if (op.op === "move-folder") {
        entry.movedFrom ??= op.from;
      }
    }
  }
  return { dryRun, entries, problems };
}

/** Whether there is anything to tell the user. */
export function isEmpty(summary: Summary): boolean {
  return !summary.entries.length && !summary.problems;
}

function itemActionOf(op: Operation): ItemAction | null {
  switch (op.op) {
    case "copy":
      return "copied";
    case "delete":
      return "deleted";
    case "rename":
      return "renamed";
    case "trash":
      return "trashed";
    case "untrash":
      return "restored";
    case "purge-trash":
      // Cleaning up after a restore is bookkeeping; erasing is not.
      return op.onlyIfEmpty ? null : "purged";
    default:
      return null;
  }
}

function collectionActionOf(op: Operation): CollectionAction | null {
  switch (op.op) {
    case "move-folder":
    case "move-file":
      return "moved";
    case "trash-collection":
      return "trashed";
    case "untrash-collection":
      return "restored";
    case "purge-collection-trash":
      return op.onlyIfEmpty ? null : "purged";
    default:
      return null;
  }
}
