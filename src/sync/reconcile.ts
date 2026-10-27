import { linked } from "../check/checks";
import { Hasher } from "../check/hash";
import { baseOf, dirOf, pathKey, relativeTo, toAbsolute } from "../check/paths";
import { readCollections, readTrash, takeSnapshot, type EntryInfo, type Snapshot } from "../check/snapshot";
import { log } from "../utils/log";
import { isDryRun } from "../utils/prefs";
import { purgeOps } from "./changes";
import { collectionTrashPath, writableRoot } from "./guard";
import { planCollectionErase, planCollectionRestore, planCollectionTrash } from "./collectionTrash";
import { planFolderMoves, recordFolders } from "./folders";
import { execute } from "./ops";
import { planEntry } from "./plan";
import type { Unfiled } from "./queue";
import type { AttachmentState } from "./state";
import { planRestore, planTrash, purgeEmptyTrashOps, purgeErasedOps } from "./trash";
import type { Intent, OpResult, PlanNote } from "./types";

export interface Reconciled {
  itemKey: string;
  notes: PlanNote[];
  results: OpResult[];
}

/**
 * Bring the files of the given items (top-level item key, or a standalone
 * attachment's key) to their target state: one snapshot, then plan and
 * execute item by item, then update the attachment state.
 */
export async function reconcile(requests: Map<string, Intent>, state: AttachmentState): Promise<Reconciled[]> {
  const root = writableRoot();
  const dryRun = isDryRun();
  let snapshot = await takeSnapshot(root);
  const hasher = new Hasher();
  const entries = new Map(snapshot.entries.map((e) => [e.key, e]));
  const done: Reconciled[] = [];
  // Restored items get their missing copies in a second round, once their files are back.
  const restored = new Map<string, Reconciled>();
  for (const [itemKey, intent] of requests) {
    const entry = entries.get(itemKey);
    if (!entry) {
      // Erased in the meantime.
      continue;
    }
    const plan = intent.trash
      ? planTrash(snapshot, entry, intent.formerCollections)
      : intent.restore
        ? planRestore(snapshot, entry)
        : await planEntry(snapshot, entry, hasher, { intent, state });
    const results = await execute(plan.operations, { dryRun });
    logNotes(itemKey, plan.notes);
    const reconciled = { itemKey, notes: plan.notes, results };
    if (intent.restore && results.some((r) => r.status === "done")) {
      restored.set(itemKey, reconciled);
      continue;
    }
    if (!intent.trash) {
      await recordAttachments(root, entry, results, dryRun, state);
    }
    done.push(reconciled);
  }
  if (restored.size) {
    snapshot = await takeSnapshot(root);
    const now = new Map(snapshot.entries.map((e) => [e.key, e]));
    for (const [itemKey, first] of restored) {
      const entry = now.get(itemKey);
      if (!entry) {
        continue;
      }
      const fill = linked(entry).map((a) => a.key);
      const plan = await planEntry(snapshot, entry, hasher, { intent: { fill }, state });
      const results = await execute([...plan.operations, ...purgeEmptyTrashOps(snapshot, entry)], { dryRun });
      logNotes(itemKey, plan.notes);
      await recordAttachments(root, entry, [...first.results, ...results], dryRun, state);
      done.push({ itemKey, notes: [...first.notes, ...plan.notes], results: [...first.results, ...results] });
    }
  }
  await state.save();
  return done;
}

/**
 * Collections renamed or moved here (§F5.1): their folders follow, and the
 * attachments in them are relinked. The recorded folders are updated unless
 * a step failed outright (then the old ones are kept for another try); a
 * file skipped because a different one is in its place stays behind and
 * the check reports it.
 */
export async function reconcileFolders(collectionIDs: number[], state: AttachmentState): Promise<OpResult[]> {
  const root = writableRoot();
  const dryRun = isDryRun();
  const snapshot = await takeSnapshot(root);
  const plan = planFolderMoves(snapshot, state, collectionIDs);
  const results = await execute(plan.operations, { dryRun });
  logNotes("collections", plan.notes);
  if (!dryRun && !results.some((r) => r.status === "failed")) {
    recordFolders(snapshot.collections, state);
    await state.save();
  }
  return results;
}

/**
 * Collections moved to Zotero's trash here (§F5.3): their folders go to the
 * plugin trash; then the live items that pointed into them are reconciled
 * (pointed at a copy elsewhere when they have one).
 */
export async function trashCollections(keys: string[], state: AttachmentState): Promise<OpResult[]> {
  const root = writableRoot();
  const dryRun = isDryRun();
  const snapshot = await takeSnapshot(root);
  const results: OpResult[] = [];
  const affected = new Set<string>();
  for (const key of keys) {
    const { plan, affected: entries } = planCollectionTrash(snapshot, state, key);
    results.push(...(await execute(plan.operations, { dryRun })));
    logNotes(`collection ${key}`, plan.notes);
    entries.forEach((e) => affected.add(e));
  }
  if (affected.size && results.some((r) => r.status === "done")) {
    await reconcile(new Map([...affected].map((k) => [k, {}])), state);
  }
  return results;
}

/** Collections restored here from Zotero's trash (§F5.3): their folders come back. */
export async function restoreCollections(keys: string[], state: AttachmentState): Promise<OpResult[]> {
  const root = writableRoot();
  const dryRun = isDryRun();
  const snapshot = await takeSnapshot(root);
  const results: OpResult[] = [];
  for (const key of keys) {
    const plan = planCollectionRestore(snapshot, state, key);
    results.push(...(await execute(plan.operations, { dryRun })));
  }
  if (!dryRun) {
    recordFolders(snapshot.collections, state);
    await state.save();
  }
  return results;
}

/**
 * Collections Zotero erased here (§F5.3): their plugin trash folders go;
 * items left in no collection are returned for the user to decide on.
 */
export async function eraseCollections(
  keys: string[],
  state: AttachmentState,
): Promise<{ results: OpResult[]; unfiled: Unfiled[] }> {
  const root = writableRoot();
  const snapshot = await takeSnapshot(root);
  const results: OpResult[] = [];
  const unfiled: Unfiled[] = [];
  for (const key of keys) {
    const hasTrashFolder = await IOUtils.exists(toAbsolute(root, collectionTrashPath(key)));
    const erased = planCollectionErase(snapshot, key, state.collectionFolder(key), hasTrashFolder);
    results.push(...(await execute(erased.plan.operations)));
    unfiled.push(...erased.unfiled);
    state.deleteCollectionFolder(key);
  }
  await state.save();
  return { results, unfiled };
}

/** Record the current folder of every collection (new ones, or changes sync brought in). */
export async function recordCollectionFolders(state: AttachmentState): Promise<void> {
  recordFolders(readCollections(Zotero.Libraries.userLibraryID), state);
  await state.save();
}

/** Delete the plugin trash folders of items or attachments Zotero erased (§F4). */
export async function purgeErased(keys: string[]): Promise<OpResult[]> {
  const root = writableRoot();
  const trash = await readTrash(root);
  const ops = purgeErasedOps({ trash }, keys);
  return ops.length ? execute(ops) : [];
}

function logNotes(itemKey: string, notes: PlanNote[]): void {
  for (const note of notes) {
    log(`sync ${itemKey}: ${note.kind}${note.path ? ` ${note.path}` : ""}`);
  }
}

async function recordAttachments(
  root: string,
  entry: EntryInfo,
  results: OpResult[],
  dryRun: boolean,
  state: AttachmentState,
): Promise<void> {
  for (const a of linked(entry)) {
    const mine = results.filter((r) => "attachmentKey" in r.operation && r.operation.attachmentKey === a.key);
    const clean = mine.every((r) => r.status === "done" || r.status === "unchanged");
    // The record keeps the previous name until the copies were really
    // renamed: in dry-run mode, or after a skipped step, the old name is
    // still needed to find them later (F3.5).
    if ((clean && !dryRun) || (!state.get(a.key) && mine.length === 0)) {
      await record(root, a.key, state);
    }
  }
}

export interface ScanSummary {
  tempFiles: OpResult[];
  purged: OpResult[];
  recorded: number;
  forgotten: number;
}

/**
 * At startup: remove temporary copies an interrupted run left behind, delete
 * replaced versions older than Zotero's trash period (§F4), record
 * attachments the state does not know yet, and forget erased ones. Records
 * already there are kept, so renames made while the plugin was not running
 * are still found.
 */
export async function scanAtStartup(state: AttachmentState): Promise<ScanSummary> {
  const root = writableRoot();
  const snapshot = await takeSnapshot(root);
  const tempFiles = await execute(snapshot.tempFiles.map((f) => ({ op: "discard-temp" as const, path: f.rel })));
  const purged = await execute(await purgeOps(root));
  const { recorded, forgotten } = recordUnknown(snapshot, state);
  await state.save();
  return { tempFiles, purged, recorded, forgotten };
}

/**
 * Record the attachments and collection folders the state does not know yet,
 * and forget erased ones, as the startup scan does (also after building a
 * test library, whose items all have new keys).
 */
export async function recordLibrary(state: AttachmentState): Promise<void> {
  recordUnknown(await takeSnapshot(writableRoot()), state);
  await state.save();
}

function recordUnknown(snapshot: Snapshot, state: AttachmentState): { recorded: number; forgotten: number } {
  const live = new Set<string>();
  let recorded = 0;
  for (const e of snapshot.entries) {
    for (const a of e.attachments) {
      if (a.linkMode !== "linked") {
        continue;
      }
      live.add(a.key);
      const file = a.rel === null ? undefined : snapshot.files.get(pathKey(a.rel));
      if (!state.get(a.key) && file && a.rel !== null) {
        state.set(a.key, { name: baseOf(a.rel), folder: dirOf(a.rel), size: file.size, mtime: file.mtime, md5: "" });
        recorded++;
      }
    }
  }
  let forgotten = 0;
  for (const key of state.keys()) {
    if (!live.has(key)) {
      state.delete(key);
      forgotten++;
    }
  }
  // Collection folders (§F5.1): record new ones; keep a known one, which
  // may be the folder of a rename made while the plugin was not running.
  for (const c of snapshot.collections.values()) {
    if (state.collectionFolder(c.key) === undefined) {
      state.setCollectionFolder(c.key, c.folder);
    }
  }
  for (const key of state.collectionKeys()) {
    if (!Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key)) {
      state.deleteCollectionFolder(key);
    }
  }
  return { recorded, forgotten };
}

/**
 * Record the name and folder Zotero now stores for an attachment changed by
 * sync. Its file may not have arrived yet, so nothing is read from disk; the
 * size and time are kept only if the path is the same.
 */
export function recordSynced(root: string, attachmentKey: string, state: AttachmentState): void {
  const attachment = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, attachmentKey);
  if (!attachment || attachment.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_FILE) {
    return;
  }
  const path = attachment.getFilePath();
  const rel = path ? relativeTo(root, path) : null;
  if (!path || rel === null) {
    return;
  }
  const name = baseOf(rel);
  const folder = dirOf(rel);
  const previous = state.get(attachmentKey);
  const same = !!previous && previous.name === name && pathKey(previous.folder) === pathKey(folder);
  state.set(attachmentKey, same ? previous : { name, folder, size: 0, mtime: 0, md5: "" });
}

/** Current name and folder of the copy Zotero points at; the MD5 is kept while size and mtime match. */
async function record(root: string, attachmentKey: string, state: AttachmentState): Promise<void> {
  const attachment = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, attachmentKey);
  const path = attachment ? attachment.getFilePath() : false;
  const rel = path ? relativeTo(root, path) : null;
  if (!path || rel === null) {
    return;
  }
  let info: Awaited<ReturnType<typeof IOUtils.stat>>;
  try {
    info = await IOUtils.stat(path);
  } catch {
    return;
  }
  const size = info.size ?? 0;
  const mtime = info.lastModified ?? 0;
  const previous = state.get(attachmentKey);
  state.set(attachmentKey, {
    name: baseOf(rel),
    folder: dirOf(rel),
    size,
    mtime,
    md5: previous && previous.size === size && previous.mtime === mtime ? previous.md5 : "",
  });
}
