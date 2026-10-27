import { collectionsOf, linked, uniqueFolders } from "../check/checks";
import { baseOf, joinRel, pathKey } from "../check/paths";
import { COLLECTIONS_BUCKET, PLUGIN_TRASH, type Snapshot } from "../check/snapshot";
import { relinkOps, under } from "./folders";
import { collectionTrashPath } from "./guard";
import type { Unfiled } from "./queue";
import type { AttachmentState } from "./state";
import type { Operation, Plan, PurgeCollectionTrashOp } from "./types";

/*
 * Collections in Zotero's trash (requirements §F5.3; Phase 3 plan, Q4 A).
 * The trashed collection's folder, its descendants' with it, moves to
 * `.attanger-plus-trash/_collections/<key>/<its path>`; a restore moves it
 * back to where the collection is now. Items only in that collection have
 * their files there meanwhile (the check reports them as in no collection
 * and missing; no window asks). Items in other collections too are pointed
 * at a copy there afterwards (a plain reconcile does that). When Zotero
 * erases the collection, the user decides about the items left in no
 * collection (see planCollectionErase), and the rest of its trash folder is
 * deleted. Only the user's own action here moves anything (Phase 3 plan,
 * 3-1).
 */

/** Move a trashed collection's folder into the plugin trash; also the live entries pointing into it. */
export function planCollectionTrash(s: Snapshot, state: AttachmentState, key: string): { plan: Plan; affected: string[] } {
  const plan: Plan = { operations: [], notes: [] };
  const folder = state.collectionFolder(key);
  if (folder === undefined || !s.folders.has(pathKey(folder))) {
    return { plan, affected: [] };
  }
  // A same-named live sibling keeps using the folder.
  const shared = [...s.collections.values()].some(
    (c) => c.folderKey === pathKey(folder) || c.folderKey.startsWith(`${pathKey(folder)}/`),
  );
  if (shared) {
    plan.notes.push({ itemKey: "", kind: "folder-shared", path: folder });
    return { plan, affected: [] };
  }
  const actual = s.folders.get(pathKey(folder))!;
  plan.operations.push({ op: "trash-collection", collectionKey: key, from: actual, to: collectionTrashPath(key, actual) });
  return { plan, affected: entriesPointingInto(s, folder) };
}

/** Bring a restored collection's folder back, to where the collection is now. */
export function planCollectionRestore(s: Snapshot, state: AttachmentState, key: string): Plan {
  const plan: Plan = { operations: [], notes: [] };
  const original = state.collectionFolder(key);
  const now = [...s.collections.values()].find((c) => c.key === key);
  if (original === undefined || !now) {
    return plan;
  }
  const files = trashedFilesOf(s, key);
  if (!files.length) {
    return plan;
  }
  const ops: Operation[] = [
    { op: "untrash-collection", collectionKey: key, from: collectionTrashPath(key, original), to: now.folder },
  ];
  if (pathKey(original) !== pathKey(now.folder)) {
    // Moved meanwhile (e.g. its parent was renamed): its attachments follow.
    // Planned before the files are back, so as relinks, not repoints.
    for (const r of relinkOps(s, original, now.folder)) {
      ops.push({ ...r, op: "relink" });
    }
  }
  ops.push({ op: "purge-collection-trash", collectionKey: key, path: collectionTrashPath(key), onlyIfEmpty: true });
  plan.operations.push(...ops);
  return plan;
}

/**
 * Zotero erased a collection (always the user's own doing: its automatic
 * trash emptying leaves collections alone). Live items whose file waits in
 * its trash folder:
 * - in another collection still: the file goes into the first of those
 *   folders and Zotero points there;
 * - in none (it was their only collection): `unfiled`, for the user to
 *   decide (Phase 3-5, option A); the folder stays until then.
 * Without such items the folder goes now.
 */
export function planCollectionErase(
  s: Snapshot,
  key: string,
  folder: string | undefined,
  /** Whether its plugin trash folder exists: it may hold only empty folders (its items took their files along). */
  hasTrashFolder: boolean,
): { plan: Plan; unfiled: Unfiled[] } {
  const plan: Plan = { operations: [], notes: [] };
  const files = trashedFilesOf(s, key);
  if (!files.length) {
    if (hasTrashFolder) {
      plan.operations.push(purgeCollectionTrashOp(key));
    }
    return { plan, unfiled: [] };
  }
  const prefix = `${collectionTrashPath(key)}/`;
  const inTrash = new Map(files.map((f) => [pathKey(f.rel.slice(prefix.length)), f.rel]));
  const unfiled: Unfiled[] = [];
  for (const e of s.entries) {
    if (e.deleted) {
      continue;
    }
    const waiting = linked(e).flatMap((a) => {
      const from = a.rel === null || s.files.has(pathKey(a.rel)) ? undefined : inTrash.get(pathKey(a.rel));
      return from ? [{ attachmentKey: a.key, from, original: a.rel! }] : [];
    });
    if (!waiting.length) {
      continue;
    }
    const folders = uniqueFolders(collectionsOf(s, e)).map((c) => c.folder);
    if (folders.length) {
      for (const w of waiting) {
        const to = joinRel(folders[0], baseOf(w.original));
        plan.operations.push(
          { op: "untrash-collection", collectionKey: key, from: w.from, to },
          { op: "relink", itemKey: e.key, attachmentKey: w.attachmentKey, to },
        );
      }
    } else {
      unfiled.push({
        itemKey: e.key,
        itemTitle: e.item.getDisplayTitle(),
        removedFrom: [],
        erased: { collectionKey: key, collectionName: folder ? baseOf(folder) : key, files: waiting },
      });
    }
  }
  if (!unfiled.length) {
    plan.operations.push(purgeCollectionTrashOp(key));
  }
  return { plan, unfiled };
}

/** Delete an erased collection's plugin trash folder (its checks keep files live items need). */
export function purgeCollectionTrashOp(key: string): PurgeCollectionTrashOp {
  return { op: "purge-collection-trash", collectionKey: key, path: collectionTrashPath(key), onlyIfEmpty: false };
}

/** Files in a collection's plugin trash folder. */
function trashedFilesOf(s: Snapshot, key: string) {
  const prefix = pathKey(`${PLUGIN_TRASH}/${COLLECTIONS_BUCKET}/${key}/`);
  return (s.trash.get(COLLECTIONS_BUCKET) ?? []).filter((f) => pathKey(f.rel).startsWith(prefix));
}

/** Live entries with an attachment pointing into a folder. */
function entriesPointingInto(s: Snapshot, folder: string): string[] {
  return s.entries
    .filter((e) => !e.deleted && linked(e).some((a) => a.rel !== null && under(a.rel, folder) !== null))
    .map((e) => e.key);
}
