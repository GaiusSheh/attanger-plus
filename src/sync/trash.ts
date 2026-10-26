import { collectionsOf, linked, uniqueFolders } from "../check/checks";
import { baseOf, dirOf, joinRel, pathKey } from "../check/paths";
import { PLUGIN_TRASH, type AttachmentInfo, type EntryInfo, type Snapshot } from "../check/snapshot";
import { trashPath } from "./guard";
import type { Plan, PurgeTrashOp, RelinkOp, UntrashOp } from "./types";

/*
 * The plugin trash follows Zotero's trash (requirements §F4). When an item
 * (or a single attachment) goes to Zotero's trash, its files — the copy
 * Zotero points at and the copies in the item's collection folders — move
 * to `.attanger-plus-trash/<key>/<their path>`, the path recording where
 * each came from. Zotero's stored path is left as it is. On restore they
 * come back into the collection folders the item belongs to now; the
 * missing copies are then made as for a new attachment. Erasing the item
 * deletes its folder.
 *
 * Only the user's own action in Zotero moves anything (Phase 3 plan, 3-1,
 * 3-2): a disagreement found later is reported by check C14.
 */

/**
 * Move the files of a trashed item, or of its trashed attachments, into the
 * plugin trash; `formerCollections` adds folders of collections the item
 * has just left (§F3.3).
 */
export function planTrash(s: Snapshot, e: EntryInfo, formerCollections: number[] = []): Plan {
  const plan: Plan = { operations: [], notes: [] };
  const inUse = liveUse(s);
  const trashed = e.deleted ? e.attachments : e.attachments.filter((a) => a.deleted);
  const former = formerCollections.map((id) => s.collections.get(id)).filter((c) => !!c);
  const folders = uniqueFolders([...collectionsOf(s, e), ...former]).map((c) => c.folder);
  for (const a of trashed) {
    if (a.linkMode !== "linked" || a.rel === null) {
      continue;
    }
    // A trashed item keeps its files in one folder; a single trashed attachment in its own.
    const bucket = e.deleted ? e.key : a.key;
    const name = baseOf(a.rel);
    const candidates = new Map<string, string>([[pathKey(a.rel), a.rel]]);
    for (const folder of folders) {
      const rel = joinRel(folder, name);
      candidates.set(pathKey(rel), rel);
    }
    for (const [key, rel] of candidates) {
      const file = s.files.get(key);
      if (!file) {
        continue;
      }
      if (inUse.has(key)) {
        plan.notes.push({ itemKey: e.key, attachmentKey: a.key, kind: "in-use", path: file.rel });
        continue;
      }
      plan.operations.push({
        op: "trash",
        itemKey: e.key,
        attachmentKey: a.key,
        path: file.rel,
        to: trashPath(bucket, file.rel),
      });
    }
  }
  return plan;
}

/**
 * Bring the files of a restored item (or attachment) back. Each file in its
 * trash folder goes back where it came from if that is still one of the
 * item's collection folders; if none can, one goes into the first of them.
 * Zotero is pointed at a restored file when its stored path has none.
 * Files with no place stay in the trash (C14 reports them). An item in no
 * collection gets its files back where they were.
 */
export function planRestore(s: Snapshot, e: EntryInfo): Plan {
  const plan: Plan = { operations: [], notes: [] };
  const folders = uniqueFolders(collectionsOf(s, e)).map((c) => c.folder);
  const folderKeys = new Set(folders.map(pathKey));
  const untrash: UntrashOp[] = [];
  const relinks: RelinkOp[] = [];
  for (const a of linked(e)) {
    if (a.rel === null) {
      continue;
    }
    const ids = { itemKey: e.key, attachmentKey: a.key };
    const inTrash = trashedFilesOf(s, e, a);
    if (!inTrash.length) {
      continue;
    }
    const placed = new Set<string>();
    const back = (from: string, to: string) => {
      untrash.push({ op: "untrash", ...ids, from, to });
      placed.add(pathKey(to));
    };
    for (const { trashRel, original } of inTrash) {
      if (!folders.length || folderKeys.has(pathKey(dirOf(original)))) {
        back(trashRel, original);
      } else {
        plan.notes.push({ ...ids, kind: "left-in-trash", path: trashRel });
      }
    }
    if (!placed.size && folders.length) {
      // None came from a current collection folder: the copy Zotero pointed at, or any.
      const pick = inTrash.find((f) => pathKey(f.original) === pathKey(a.rel!)) ?? inTrash[0];
      const to = joinRel(folders[0], baseOf(pick.original));
      back(pick.trashRel, to);
      plan.notes = plan.notes.filter((n) => n.path !== pick.trashRel);
    }
    if (!placed.has(pathKey(a.rel)) && !s.files.has(pathKey(a.rel))) {
      relinks.push({ op: "relink", ...ids, to: untrash.find((u) => u.attachmentKey === a.key)!.to });
    }
  }
  plan.operations.push(...untrash, ...relinks);
  return plan;
}

/** After a restore: remove the trash folders of the item and its attachments if nothing is left in them. */
export function purgeEmptyTrashOps(s: Snapshot, e: EntryInfo): PurgeTrashOp[] {
  const keys = new Set([e.key, ...e.attachments.map((a) => a.key)]);
  return [...keys]
    .filter((key) => s.trash.has(key))
    .map((key) => ({ op: "purge-trash" as const, itemKey: key, path: `${PLUGIN_TRASH}/${key}`, onlyIfEmpty: true }));
}

/** Delete the plugin trash folders of erased items or attachments that have one. */
export function purgeErasedOps(s: Pick<Snapshot, "trash">, keys: string[]): PurgeTrashOp[] {
  return keys
    .filter((key) => s.trash.has(key))
    .map((key) => ({ op: "purge-trash" as const, itemKey: key, path: `${PLUGIN_TRASH}/${key}`, onlyIfEmpty: false }));
}

/** Files of attachment `a` in the trash folders of its item and of itself, with where each came from. */
function trashedFilesOf(s: Snapshot, e: EntryInfo, a: AttachmentInfo): { trashRel: string; original: string }[] {
  const name = pathKey(baseOf(a.rel!));
  const found: { trashRel: string; original: string }[] = [];
  for (const bucket of new Set([e.key, a.key])) {
    const prefix = `${PLUGIN_TRASH}/${bucket}/`;
    for (const f of s.trash.get(bucket) ?? []) {
      if (f.rel.startsWith(prefix) && pathKey(baseOf(f.rel)) === name) {
        found.push({ trashRel: f.rel, original: f.rel.slice(prefix.length) });
      }
    }
  }
  return found;
}

/**
 * Where live items keep files (known_pits A8), by pathKey: what their
 * linked attachments point at, and the copy positions in their collection
 * folders.
 */
function liveUse(s: Snapshot): Set<string> {
  const used = new Set<string>();
  for (const e of s.entries) {
    if (e.deleted) {
      continue;
    }
    const folders = uniqueFolders(collectionsOf(s, e)).map((c) => c.folder);
    for (const a of linked(e)) {
      if (a.rel === null) {
        continue;
      }
      used.add(pathKey(a.rel));
      for (const folder of folders) {
        used.add(pathKey(joinRel(folder, baseOf(a.rel))));
      }
    }
  }
  return used;
}
