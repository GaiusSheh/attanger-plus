import { collectionsOf, linked, uniqueFolders } from "../check/checks";
import type { Hasher } from "../check/hash";
import { baseOf, dirOf, joinRel, pathKey } from "../check/paths";
import type { AttachmentInfo, DiskFile, EntryInfo, Snapshot } from "../check/snapshot";
import type { AttachmentState } from "./state";
import type { CopyOp, DeleteOp, Intent, Plan, RelinkOp, RenameOp } from "./types";

/*
 * Target state of an item's files: in each of its collection folders, one
 * byte-identical copy of every linked attachment, named like the copy Zotero
 * points at. planEntry() compares that with the snapshot and lists what to
 * do. It is read-only; its output is the dry-run preview.
 *
 * Copies are made and files deleted only on a Zotero intent (see Intent); a
 * missing or misplaced file without one is only noted, as it may come from
 * the file manager, where the plugin only reports (requirements §3.2).
 * Moves that lose nothing are always planned: pointing at an existing copy
 * when Zotero's copy is gone (F3.7), moving a file out of the files root
 * itself — where Attanger puts files of items in no collection — into the
 * item's collection folder (Phase 2 plan, Q4), and renaming copies left
 * under an attachment's previous name (F3.5).
 *
 * Operations are ordered renames, copies, relinks, deletes, so that each one
 * finds the files the earlier ones produced.
 */

export interface PlanOptions {
  intent?: Intent;
  /** Last known file names, for copies left under an attachment's old name (F3.5). */
  state?: AttachmentState;
}

export async function planEntry(s: Snapshot, e: EntryInfo, hasher: Hasher, options: PlanOptions = {}): Promise<Plan> {
  const plan: Plan = { operations: [], notes: [] };
  if (e.deleted) {
    // Zotero's trash is Phase 3 (F4).
    return plan;
  }
  const folders = uniqueFolders(collectionsOf(s, e)).map((c) => c.folder);
  if (!folders.length) {
    // Removed from its last collection: F3.3, Phase 3. Files stay as they are.
    if (linked(e).length) {
      plan.notes.push({ itemKey: e.key, kind: "no-collection" });
    }
    return plan;
  }
  const folderKeys = new Set(folders.map(pathKey));
  const added = new Set<string>();
  for (const id of options.intent?.addedTo ?? []) {
    const folder = s.collections.get(id)?.folder;
    if (folder !== undefined) {
      added.add(pathKey(folder));
    }
  }
  const fill = new Set(options.intent?.fill ?? []);
  const removed = new Map<string, string>();
  for (const id of options.intent?.removedFrom ?? []) {
    const folder = s.collections.get(id)?.folder;
    // Two collections can share a folder; it stays if the item is still in one.
    if (folder !== undefined && !folderKeys.has(pathKey(folder))) {
      removed.set(pathKey(folder), folder);
    }
  }

  const ops = { renames: [] as RenameOp[], copies: [] as CopyOp[], relinks: [] as RelinkOp[], deletes: [] as DeleteOp[] };
  for (const a of linked(e)) {
    await planAttachment(s, e, a, { folders, folderKeys, added, fill, removed, hasher, state: options.state }, ops, plan);
  }
  plan.operations.push(...ops.renames, ...ops.copies, ...ops.relinks, ...ops.deletes);
  return plan;
}

interface Context {
  folders: string[];
  folderKeys: Set<string>;
  /** Folders of collections the item was just added to, by pathKey. */
  added: Set<string>;
  /** Attachments whose missing copies are all to be made. */
  fill: Set<string>;
  /** Folders of collections the item was just removed from: pathKey -> folder. */
  removed: Map<string, string>;
  hasher: Hasher;
  state?: AttachmentState;
}

interface Planned {
  renames: RenameOp[];
  copies: CopyOp[];
  relinks: RelinkOp[];
  deletes: DeleteOp[];
}

async function planAttachment(s: Snapshot, e: EntryInfo, a: AttachmentInfo, ctx: Context, ops: Planned, plan: Plan) {
  const ids = { itemKey: e.key, attachmentKey: a.key };
  if (!a.abs || a.rel === null) {
    plan.notes.push({ ...ids, kind: "outside-root", path: a.abs ?? undefined });
    return;
  }
  const name = baseOf(a.rel);
  const pointedDir = dirOf(a.rel);
  const pointed = s.files.get(pathKey(a.rel));
  const copyIn = (folder: string) => joinRel(folder, name);
  const fileIn = (folder: string) => s.files.get(pathKey(copyIn(folder)));
  const deleting = new Set<string>();

  // `source`: the content every copy must have, found at `sourceRel` now.
  // `home`: folder of the copy Zotero will point at once the plan has run.
  let source: DiskFile;
  let sourceRel: string;
  let home: string;
  if (pointed && ctx.folderKeys.has(pathKey(pointedDir))) {
    source = pointed;
    sourceRel = a.rel;
    home = pointedDir;
  } else if (!pointed) {
    const found = ctx.folders.find((f) => fileIn(f));
    if (found === undefined) {
      plan.notes.push({ ...ids, kind: "all-missing", path: a.rel });
      return;
    }
    source = fileIn(found)!;
    sourceRel = copyIn(found);
    home = found;
    ops.relinks.push({ op: "relink", ...ids, to: sourceRel });
  } else {
    // Zotero's copy is outside the item's collection folders.
    if (pointedDir !== "" && !ctx.removed.has(pathKey(pointedDir))) {
      plan.notes.push({ ...ids, kind: "misplaced", path: a.rel });
      return;
    }
    source = pointed;
    sourceRel = a.rel;
    let target: string | undefined;
    for (const f of ctx.folders) {
      const file = fileIn(f);
      if (file && (await ctx.hasher.same(file, pointed))) {
        target = f;
        break;
      }
    }
    if (target === undefined) {
      target = ctx.folders.find((f) => !fileIn(f));
      if (target === undefined) {
        plan.notes.push({ ...ids, kind: "copy-differs", path: copyIn(ctx.folders[0]) });
        return;
      }
      ops.copies.push({ op: "copy", ...ids, from: a.rel, to: copyIn(target) });
    }
    ops.relinks.push({ op: "relink", ...ids, to: copyIn(target) });
    ops.deletes.push({ op: "delete", ...ids, path: a.rel, keep: copyIn(target) });
    deleting.add(pathKey(a.rel));
    home = target;
  }

  const previous = ctx.state?.get(a.key);
  const oldName = previous && previous.name !== name ? previous.name : null;
  for (const f of ctx.folders) {
    if (pathKey(f) === pathKey(home)) {
      continue;
    }
    const rel = copyIn(f);
    const file = fileIn(f);
    if (file) {
      // Which copy was edited is F3.6's call (Phase 2-5), made with the state record.
      if (!(await ctx.hasher.same(file, source))) {
        plan.notes.push({ ...ids, kind: "copy-differs", path: rel });
      }
      continue;
    }
    if (oldName) {
      const oldRel = joinRel(f, oldName);
      const oldFile = s.files.get(pathKey(oldRel));
      if (oldFile && (await ctx.hasher.same(oldFile, source))) {
        ops.renames.push({ op: "rename", ...ids, from: oldRel, to: rel });
        continue;
      }
    }
    if (ctx.fill.has(a.key) || ctx.added.has(pathKey(f))) {
      ops.copies.push({ op: "copy", ...ids, from: sourceRel, to: rel });
    } else {
      plan.notes.push({ ...ids, kind: "copy-missing", path: rel });
    }
  }

  for (const [key, folder] of ctx.removed) {
    const rel = copyIn(folder);
    const file = fileIn(folder);
    if (!file || deleting.has(pathKey(rel)) || key === pathKey(home)) {
      continue;
    }
    if (await ctx.hasher.same(file, source)) {
      ops.deletes.push({ op: "delete", ...ids, path: rel, keep: copyIn(home) });
    } else {
      plan.notes.push({ ...ids, kind: "removed-copy-differs", path: rel });
    }
  }
}
