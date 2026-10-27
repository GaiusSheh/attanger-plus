import { linked } from "../check/checks";
import { joinRel, pathKey } from "../check/paths";
import type { CollectionInfo, Snapshot } from "../check/snapshot";
import type { AttachmentState } from "./state";
import type { MoveFileOp, Operation, Plan, RelinkOp, RepointOp } from "./types";

/*
 * Collection folders follow their collections (requirements §F5.1). A
 * renamed or moved collection's folder is compared with the one recorded
 * for it (the event does not say where descendants' folders were). If the
 * new place is free the whole folder moves at once, descendants included;
 * otherwise file by file, never over a different file, and the old folder
 * goes once empty. Attachments pointing into the old folder are relinked.
 * Each move is logged with its old and new path, so that links from
 * outside (junctions, shortcuts) can be fixed by the user's own tools.
 */

/** Plan the folder moves for collections that changed name or parent here. */
export function planFolderMoves(s: Snapshot, state: AttachmentState, collectionIDs: number[]): Plan {
  const plan: Plan = { operations: [], notes: [] };
  const changed = collectionIDs
    .map((id) => s.collections.get(id))
    .filter((c): c is CollectionInfo => !!c)
    // Parents first: their move takes the descendants' folders along.
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  const handled = new Set<string>();
  for (const c of changed) {
    const from = state.collectionFolder(c.key);
    const to = c.folder;
    if (from === undefined || from === to || handled.has(pathKey(from))) {
      continue;
    }
    const moved = descendantsOf(s, c);
    // A same-named sibling (or "/" in a name) can map two collections to one folder.
    const sharedBy = [...s.collections.values()].find(
      (other) =>
        !moved.has(other.id) && (other.folderKey === pathKey(from) || other.folderKey.startsWith(`${pathKey(from)}/`)),
    );
    if (sharedBy) {
      plan.notes.push({ itemKey: "", kind: "folder-shared", path: from });
      continue;
    }
    handled.add(pathKey(from));
    plan.operations.push(...moveOps(s, c.key, from, to), ...relinkOps(s, from, to));
  }
  return plan;
}

/** The recorded folder of every collection becomes where it is now. */
export function recordFolders(collections: Snapshot["collections"], state: AttachmentState): void {
  for (const c of collections.values()) {
    state.setCollectionFolder(c.key, c.folder);
  }
}

function moveOps(s: Snapshot, collectionKey: string, from: string, to: string): Operation[] {
  const fromKey = pathKey(from);
  if (!s.folders.has(fromKey)) {
    // Nothing on disk yet (e.g. a collection without files).
    return [];
  }
  const caseOnly = fromKey === pathKey(to);
  if (caseOnly || !s.folders.has(pathKey(to))) {
    return [{ op: "move-folder", collectionKey, from: s.folders.get(fromKey)!, to }];
  }
  const files: MoveFileOp[] = [];
  for (const f of s.files.values()) {
    const rel = under(f.rel, from);
    if (rel !== null) {
      files.push({ op: "move-file", collectionKey, from: f.rel, to: joinRel(to, rel) });
    }
  }
  return [...files, { op: "remove-empty-folder", collectionKey, path: s.folders.get(fromKey)! }];
}

/**
 * Live linked attachments pointing into the old folder now point into the
 * new one: relinked to the moved file, or, when their file was already
 * missing, only their stored path changed, so that the place it belongs
 * follows the collection (the check then reports it missing, not also
 * misplaced).
 */
function relinkOps(s: Snapshot, from: string, to: string): (RelinkOp | RepointOp)[] {
  const ops: (RelinkOp | RepointOp)[] = [];
  for (const e of s.entries) {
    if (e.deleted) {
      continue;
    }
    for (const a of linked(e)) {
      const rel = a.rel === null ? null : under(a.rel, from);
      if (rel !== null) {
        const op = s.files.has(pathKey(a.rel!)) ? "relink" : "repoint";
        ops.push({ op, itemKey: e.key, attachmentKey: a.key, to: joinRel(to, rel) });
      }
    }
  }
  return ops;
}

/** `rel` relative to `folder` when it lies inside it, else null. */
function under(rel: string, folder: string): string | null {
  const prefix = `${pathKey(folder)}/`;
  return pathKey(rel).startsWith(prefix) ? rel.slice(prefix.length) : null;
}

/** The collection and all collections below it, by ID. */
function descendantsOf(s: Snapshot, c: CollectionInfo): Set<number> {
  const found = new Set<number>([c.id]);
  const stack = [...c.childIDs];
  while (stack.length) {
    const id = stack.pop()!;
    if (!found.has(id)) {
      found.add(id);
      stack.push(...(s.collections.get(id)?.childIDs ?? []));
    }
  }
  return found;
}
