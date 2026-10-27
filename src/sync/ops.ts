import { Hasher } from "../check/hash";
import { pathKey, relativeTo, toAbsolute } from "../check/paths";
import { COLLECTIONS_BUCKET, PLUGIN_TRASH, SET_ASIDE_BUCKETS, TEMP_SUFFIX, type DiskFile } from "../check/snapshot";
import { isDryRun } from "../utils/prefs";
import {
  resolveCollectionTrashPath,
  resolveInRoot,
  resolveReplacedPath,
  resolveTrashPath,
  Skip,
  writableRoot,
} from "./guard";
import { appendLog } from "./log";
import type {
  CopyOp,
  DeleteOp,
  DiscardTempOp,
  ImportOp,
  MoveFileOp,
  MoveFolderOp,
  Operation,
  OpResult,
  PurgeCollectionTrashOp,
  PurgeReplacedOp,
  PurgeTrashOp,
  RelinkOp,
  RemoveEmptyFolderOp,
  RenameOp,
  RepointOp,
  ReplaceOp,
  SetAsideOp,
  TrashOp,
  UntrashOp,
} from "./types";

/*
 * Carry out planned operations one at a time. Each re-checks its
 * preconditions against the disk and the library as they are now (the plan
 * may be stale), never overwrites a file, verifies its result, and is logged.
 * The one replacement (`replace`, on the user's explicit choice, §F3.6)
 * first moves the old file into the plugin trash.
 */

export interface ExecuteOptions {
  /** Defaults to the "dryRun" preference. */
  dryRun?: boolean;
}

export async function execute(operations: Operation[], options: ExecuteOptions = {}): Promise<OpResult[]> {
  const root = writableRoot();
  const dryRun = options.dryRun ?? isDryRun();
  const hasher = new Hasher();
  const results: OpResult[] = [];
  for (const operation of operations) {
    let result: OpResult;
    try {
      result = dryRun ? dryRunResult(root, operation) : await run(root, operation, hasher);
    } catch (e) {
      result =
        e instanceof Skip
          ? { operation, status: "skipped", reason: e.reason }
          : { operation, status: "failed", reason: String(e) };
    }
    await appendLog(result, dryRun);
    results.push(result);
    // Keep Zotero responsive during long batches (known_pits C1).
    await Zotero.Promise.delay(0);
  }
  return results;
}

/** Only the path checks; later operations often depend on earlier ones having run. */
function dryRunResult(root: string, operation: Operation): OpResult {
  for (const rel of pathsOf(operation)) {
    resolveInRoot(root, rel);
  }
  if (operation.op === "replace") {
    resolveReplacedPath(root, operation.backup);
  } else if (operation.op === "purge-replaced") {
    resolveReplacedPath(root, operation.path);
  } else if (operation.op === "trash") {
    trashSource(root, operation.path);
    resolveTrashPath(root, operation.to);
  } else if (operation.op === "untrash") {
    resolveTrashPath(root, operation.from);
  } else if (operation.op === "purge-trash") {
    resolveTrashPath(root, operation.path, "folder");
  } else if (operation.op === "trash-collection") {
    resolveCollectionTrashPath(root, operation.to);
  } else if (operation.op === "untrash-collection") {
    resolveCollectionTrashPath(root, operation.from);
  } else if (operation.op === "purge-collection-trash") {
    resolveCollectionTrashPath(root, operation.path, "folder");
  } else if (operation.op === "set-aside") {
    setAsideSource(root, operation.path);
    resolveReplacedPath(root, operation.to);
  }
  return { operation, status: "dry-run" };
}

/** Paths that must lie in the root outside the plugin trash. */
function pathsOf(operation: Operation): string[] {
  switch (operation.op) {
    case "copy":
    case "rename":
    case "replace":
      return [operation.from, operation.to];
    case "import":
      return [operation.to];
    case "delete":
      return [operation.path, operation.keep];
    case "relink":
      return [operation.to];
    case "discard-temp":
      return [operation.path];
    case "trash":
      // Checked by trashSource(): it may also lie in a collection's plugin trash.
      return [];
    case "untrash":
      return [operation.to];
    case "move-folder":
    case "move-file":
      return [operation.from, operation.to];
    case "remove-empty-folder":
      return [operation.path];
    case "repoint":
      return [operation.to];
    case "trash-collection":
      return [operation.from];
    case "untrash-collection":
      return [operation.to];
    case "purge-collection-trash":
      return [];
    case "purge-replaced":
    case "purge-trash":
      return [];
    case "set-aside":
      // Checked by setAsideSource(): it may also lie in an unclaimed plugin trash folder.
      return [];
  }
}

async function run(root: string, operation: Operation, hasher: Hasher): Promise<OpResult> {
  switch (operation.op) {
    case "copy":
      return copy(root, operation, hasher);
    case "delete":
      return remove(root, operation, hasher);
    case "rename":
      return rename(root, operation);
    case "relink":
      return relink(root, operation, hasher);
    case "discard-temp":
      return discardTemp(root, operation);
    case "replace":
      return replace(root, operation, hasher);
    case "purge-replaced":
      return purgeReplaced(root, operation);
    case "import":
      return importFile(root, operation, hasher);
    case "trash":
      return trash(root, operation, hasher);
    case "untrash":
      return untrash(root, operation, hasher);
    case "purge-trash":
      return purgeTrash(root, operation);
    case "move-folder":
      return moveFolder(root, operation);
    case "move-file":
      return moveFile(root, operation, hasher);
    case "remove-empty-folder":
      return removeEmptyFolder(root, operation);
    case "repoint":
      return repoint(root, operation);
    case "trash-collection":
      return moveTreeOp(operation, resolveInRoot(root, operation.from), resolveCollectionTrashPath(root, operation.to), hasher);
    case "untrash-collection":
      return moveTreeOp(operation, resolveCollectionTrashPath(root, operation.from), resolveInRoot(root, operation.to), hasher);
    case "purge-collection-trash":
      return purgeCollectionTrash(root, operation);
    case "set-aside":
      return setAside(root, operation);
  }
}

/**
 * Set a stray file aside (§F1.3), unless a live attachment points at it.
 * A plugin trash folder left without files by it goes too.
 */
async function setAside(root: string, op: SetAsideOp): Promise<OpResult> {
  const from = setAsideSource(root, op.path);
  const to = resolveReplacedPath(root, op.to);
  if (!(await fileAt(from))) {
    if (await fileAt(to)) {
      return { operation: op, status: "unchanged", reason: "already-moved" };
    }
    throw new Skip("source-missing", op.path);
  }
  if ((await pointedFiles(root, { liveOnly: true })).has(pathKey(op.path))) {
    throw new Skip("in-use", op.path);
  }
  if (await IOUtils.exists(to)) {
    throw new Skip("target-exists", op.to);
  }
  await IOUtils.makeDirectory(PathUtils.parent(to)!, { createAncestors: true, ignoreExisting: true });
  await IOUtils.move(from, to, { noOverwrite: true });
  if (!(await IOUtils.exists(to)) || (await IOUtils.exists(from))) {
    throw new Error(`setting aside not completed: ${op.path}`);
  }
  const parts = op.path.split("/");
  if (pathKey(parts[0]) === pathKey(PLUGIN_TRASH)) {
    const folder = toAbsolute(root, `${parts[0]}/${parts[1]}`);
    if (!(await filesUnder(folder)).length) {
      await clearReadOnlyTree(folder);
      await IOUtils.remove(folder, { recursive: true });
    }
  }
  return { operation: op, status: "done" };
}

/**
 * Where a file is set aside from: the root outside the plugin trash, or a
 * plugin trash folder other than the areas the plugin keeps itself
 * (collections' folders, replaced versions, files already set aside).
 */
function setAsideSource(root: string, rel: string): string {
  try {
    return resolveInRoot(root, rel);
  } catch (e) {
    if (!(e instanceof Skip && e.reason === "in-plugin-trash")) {
      throw e;
    }
    const bucket = rel.split("/")[1] ?? "";
    if (rel.split("/").length < 3 || bucket === COLLECTIONS_BUCKET || SET_ASIDE_BUCKETS.includes(bucket)) {
      throw new Skip("not-a-stray-trash-file", rel);
    }
    return toAbsolute(root, rel);
  }
}

/**
 * A collection's folder (or one file) into or out of the plugin trash
 * (§F5.3): moved at once if the target is free, else file by file, an
 * identical file in place counting as moved and a different one staying
 * behind (reported as skipped); emptied source folders go.
 */
async function moveTreeOp(operation: Operation, from: string, to: string, hasher: Hasher): Promise<OpResult> {
  if (!(await IOUtils.exists(from))) {
    if (await IOUtils.exists(to)) {
      return { operation, status: "unchanged", reason: "already-moved" };
    }
    throw new Skip("source-missing", from);
  }
  const kept = await moveTree(from, to, hasher);
  if (kept.length) {
    throw new Skip("target-exists-differs", `${kept.length} file(s) left in ${from}, e.g. ${kept[0]}`);
  }
  return { operation, status: "done" };
}

/** Returns the files that stayed behind because a different file is in their place. */
async function moveTree(from: string, to: string, hasher: Hasher): Promise<string[]> {
  const info = await IOUtils.stat(from);
  if (!(await IOUtils.exists(to))) {
    if (Zotero.isWin) {
      // OneDrive marks folders read-only (known_pits B1).
      await IOUtils.setWindowsAttributes(from, { readOnly: false });
    }
    await IOUtils.makeDirectory(PathUtils.parent(to)!, { createAncestors: true, ignoreExisting: true });
    await IOUtils.move(from, to, { noOverwrite: true });
    if (!(await IOUtils.exists(to)) || (await IOUtils.exists(from))) {
      throw new Error(`move not completed: ${from} -> ${to}`);
    }
    return [];
  }
  if (info.type !== "directory") {
    const source = await fileAt(from);
    const existing = await fileAt(to);
    if (source && existing && (await hasher.same(source, existing))) {
      await removeFile(from);
      return [];
    }
    return [from];
  }
  const kept: string[] = [];
  for (const child of await IOUtils.getChildren(from)) {
    kept.push(...(await moveTree(child, PathUtils.join(to, PathUtils.filename(child)), hasher)));
  }
  if (!kept.length) {
    await clearReadOnlyTree(from);
    await IOUtils.remove(from, { recursive: true });
  }
  return kept;
}

/**
 * A trashed collection's plugin trash folder. After a restore only an
 * empty one goes. After Zotero erased the collection the rest goes, unless
 * the collection still exists or a live attachment needs a file of it (its
 * file is missing where the attachment points, and here is one of that
 * path); such files are moved back first (see reconcile.ts).
 */
async function purgeCollectionTrash(root: string, op: PurgeCollectionTrashOp): Promise<OpResult> {
  const path = resolveCollectionTrashPath(root, op.path, "folder");
  if (!(await IOUtils.exists(path))) {
    return { operation: op, status: "unchanged", reason: "already-absent" };
  }
  const files = await filesUnder(path);
  if (op.onlyIfEmpty && files.length) {
    throw new Skip("not-empty", `${op.path} (${files.length} file(s))`);
  }
  if (!op.onlyIfEmpty) {
    const collection = Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, op.collectionKey);
    if (collection) {
      throw new Skip("collection-exists", op.collectionKey);
    }
    const live = await pointedFiles(root, { liveOnly: true });
    for (const file of files) {
      const original = relativeTo(path, file);
      if (original !== null && live.has(pathKey(original)) && !(await IOUtils.exists(toAbsolute(root, original)))) {
        throw new Skip("in-use", original);
      }
    }
  }
  await clearReadOnlyTree(path);
  await IOUtils.remove(path, { recursive: true });
  return { operation: op, status: "done" };
}

/**
 * Only for an attachment whose file is missing: its stored path moves with
 * its collection's folder. If its file exists, or one is already at the new
 * place, this is a case for a relink, not for this.
 */
async function repoint(root: string, op: RepointOp): Promise<OpResult> {
  const to = resolveInRoot(root, op.to);
  const attachment = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, op.attachmentKey);
  if (
    !attachment ||
    !attachment.isAttachment() ||
    attachment.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_FILE
  ) {
    throw new Skip("not-a-linked-attachment", op.attachmentKey);
  }
  const current = attachment.getFilePath() || null;
  if (current && pathKey(relativeTo(root, current) ?? current) === pathKey(op.to)) {
    return { operation: op, status: "unchanged", reason: "already-pointed" };
  }
  if (current && (await IOUtils.exists(current))) {
    throw new Skip("file-exists", current);
  }
  if (await IOUtils.exists(to)) {
    throw new Skip("target-exists", op.to);
  }
  attachment.attachmentPath = to;
  await attachment.saveTx();
  const now = attachment.getFilePath();
  if (!now || pathKey(relativeTo(root, now) ?? now) !== pathKey(op.to)) {
    throw new Error(`repoint not applied: now ${String(now)}, expected ${op.to}`);
  }
  return { operation: op, status: "done" };
}

/**
 * A collection's folder to its new place, in one move (§F5.1). A change of
 * case only goes through a temporary name: on case-insensitive file systems
 * a direct move is a no-op.
 */
async function moveFolder(root: string, op: MoveFolderOp): Promise<OpResult> {
  const from = resolveInRoot(root, op.from);
  const to = resolveInRoot(root, op.to);
  if (op.from === op.to) {
    return { operation: op, status: "unchanged", reason: "same-path" };
  }
  if (pathKey(op.to).startsWith(`${pathKey(op.from)}/`)) {
    throw new Skip("into-itself", op.to);
  }
  const caseOnly = pathKey(op.from) === pathKey(op.to);
  if (!(await isFolder(from))) {
    if (!caseOnly && (await isFolder(to))) {
      return { operation: op, status: "unchanged", reason: "already-moved" };
    }
    throw new Skip("source-missing", op.from);
  }
  if (!caseOnly && (await IOUtils.exists(to))) {
    throw new Skip("target-exists", op.to);
  }
  if (Zotero.isWin) {
    // OneDrive marks folders read-only (known_pits B1).
    await IOUtils.setWindowsAttributes(from, { readOnly: false });
  }
  await IOUtils.makeDirectory(PathUtils.parent(to)!, { createAncestors: true, ignoreExisting: true });
  if (caseOnly) {
    const tmp = to + TEMP_SUFFIX;
    await IOUtils.move(from, tmp, { noOverwrite: true });
    await IOUtils.move(tmp, to, { noOverwrite: true });
  } else {
    await IOUtils.move(from, to, { noOverwrite: true });
  }
  if (!(await isFolder(to)) || (!caseOnly && (await IOUtils.exists(from)))) {
    throw new Error(`folder move not completed: ${op.from} -> ${op.to}`);
  }
  return { operation: op, status: "done" };
}

/** One file into a new folder that already exists; an identical file there means it is already in place. */
async function moveFile(root: string, op: MoveFileOp, hasher: Hasher): Promise<OpResult> {
  const from = resolveInRoot(root, op.from);
  const to = resolveInRoot(root, op.to);
  const source = await fileAt(from);
  const existing = await fileAt(to);
  if (!source) {
    if (existing) {
      return { operation: op, status: "unchanged", reason: "already-moved" };
    }
    throw new Skip("source-missing", op.from);
  }
  if (existing) {
    if (!(await hasher.same(source, existing))) {
      throw new Skip("target-exists-differs", op.to);
    }
    await removeFile(from);
    return { operation: op, status: "done", reason: "identical-already-there" };
  }
  await IOUtils.makeDirectory(PathUtils.parent(to)!, { createAncestors: true, ignoreExisting: true });
  await IOUtils.move(from, to, { noOverwrite: true });
  if (!(await IOUtils.exists(to)) || (await IOUtils.exists(from))) {
    throw new Error(`file move not completed: ${op.from} -> ${op.to}`);
  }
  return { operation: op, status: "done" };
}

/** Only a folder holding nothing but (empty) folders. */
async function removeEmptyFolder(root: string, op: RemoveEmptyFolderOp): Promise<OpResult> {
  const path = resolveInRoot(root, op.path);
  if (!(await IOUtils.exists(path))) {
    return { operation: op, status: "unchanged", reason: "already-absent" };
  }
  const files = await filesUnder(path);
  if (files.length) {
    throw new Skip("not-empty", `${op.path} (${files.length} file(s))`);
  }
  await clearReadOnlyTree(path);
  await IOUtils.remove(path, { recursive: true });
  return { operation: op, status: "done" };
}

async function isFolder(abs: string): Promise<boolean> {
  try {
    return (await IOUtils.stat(abs)).type === "directory";
  } catch {
    return false;
  }
}

/**
 * Into the plugin trash, unless a live attachment points at the file
 * (known_pits A8: after merging duplicates, a trashed item's file can be the
 * surviving item's copy). An identical file already in the trash means the
 * move was done before; the one left behind goes.
 */
async function trash(root: string, op: TrashOp, hasher: Hasher): Promise<OpResult> {
  const from = trashSource(root, op.path);
  const to = resolveTrashPath(root, op.to);
  const source = await fileAt(from);
  const existing = await fileAt(to);
  if (!source) {
    if (existing) {
      return { operation: op, status: "unchanged", reason: "already-in-trash" };
    }
    throw new Skip("source-missing", op.path);
  }
  if ((await pointedFiles(root, { liveOnly: true })).has(pathKey(op.path))) {
    throw new Skip("in-use", op.path);
  }
  if (existing) {
    if (!(await hasher.same(source, existing))) {
      throw new Skip("target-exists-differs", op.to);
    }
    await removeFile(from);
    return { operation: op, status: "done", reason: "identical-already-in-trash" };
  }
  await IOUtils.makeDirectory(PathUtils.parent(to)!, { createAncestors: true, ignoreExisting: true });
  await IOUtils.move(from, to, { noOverwrite: true });
  if (!(await IOUtils.exists(to)) || (await IOUtils.exists(from))) {
    throw new Error(`move into the plugin trash not completed: ${op.path}`);
  }
  return { operation: op, status: "done" };
}

/** Where a file goes into an item's trash from: the root, or an erased collection's plugin trash folder. */
function trashSource(root: string, rel: string): string {
  try {
    return resolveInRoot(root, rel);
  } catch (e) {
    if (e instanceof Skip && e.reason === "in-plugin-trash") {
      return resolveCollectionTrashPath(root, rel);
    }
    throw e;
  }
}

/** Back out of the plugin trash; never over a different file. */
async function untrash(root: string, op: UntrashOp, hasher: Hasher): Promise<OpResult> {
  const from = resolveTrashPath(root, op.from);
  const to = resolveInRoot(root, op.to);
  const source = await fileAt(from);
  const existing = await fileAt(to);
  if (!source) {
    if (existing) {
      return { operation: op, status: "unchanged", reason: "already-restored" };
    }
    throw new Skip("source-missing", op.from);
  }
  if (existing) {
    if (!(await hasher.same(source, existing))) {
      throw new Skip("target-exists-differs", op.to);
    }
    await removeFile(from);
    return { operation: op, status: "unchanged", reason: "identical-file-in-place" };
  }
  await IOUtils.makeDirectory(PathUtils.parent(to)!, { createAncestors: true, ignoreExisting: true });
  await IOUtils.move(from, to, { noOverwrite: true });
  if (!(await IOUtils.exists(to)) || (await IOUtils.exists(from))) {
    throw new Error(`move out of the plugin trash not completed: ${op.from}`);
  }
  return { operation: op, status: "done" };
}

/**
 * A plugin trash folder. After a restore only an empty one (nothing but
 * folders) goes; after Zotero erased the item, everything in it, unless the
 * item still lives or an attachment points inside.
 */
async function purgeTrash(root: string, op: PurgeTrashOp): Promise<OpResult> {
  const path = resolveTrashPath(root, op.path, "folder");
  if (!(await IOUtils.exists(path))) {
    return { operation: op, status: "unchanged", reason: "already-absent" };
  }
  const files = await filesUnder(path);
  if (op.onlyIfEmpty && files.length) {
    throw new Skip("not-empty", `${op.path} (${files.length} file(s))`);
  }
  if (!op.onlyIfEmpty) {
    const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, op.itemKey);
    if (item && !item.deleted) {
      throw new Skip("item-alive", op.itemKey);
    }
    const prefix = pathKey(`${op.path}/`);
    for (const pointed of await pointedFiles(root)) {
      if (pointed.startsWith(prefix)) {
        throw new Skip("pointed-by-attachment", pointed);
      }
    }
  }
  await clearReadOnlyTree(path);
  await IOUtils.remove(path, { recursive: true });
  return { operation: op, status: "done" };
}

/** Regular files anywhere under a folder. */
async function filesUnder(abs: string): Promise<string[]> {
  const found: string[] = [];
  for (const child of await IOUtils.getChildren(abs)) {
    const info = await IOUtils.stat(child);
    if (info.type === "directory") {
      found.push(...(await filesUnder(child)));
    } else {
      found.push(child);
    }
  }
  return found;
}

/** A file the user picked, from anywhere, into the root; never over an existing file. */
async function importFile(root: string, op: ImportOp, hasher: Hasher): Promise<OpResult> {
  const to = resolveInRoot(root, op.to);
  if (!PathUtils.isAbsolute(op.from)) {
    throw new Skip("not-an-absolute-path", op.from);
  }
  const source = await fileAt(op.from);
  if (!source) {
    throw new Skip("source-missing", op.from);
  }
  if (await IOUtils.exists(to)) {
    throw new Skip("target-exists", op.to);
  }
  await IOUtils.makeDirectory(PathUtils.parent(to)!, { createAncestors: true, ignoreExisting: true });
  const tmp = to + TEMP_SUFFIX;
  await removeFile(tmp);
  try {
    await IOUtils.copy(op.from, tmp, { noOverwrite: true });
    const copied = await fileAt(tmp);
    if (!copied || !(await hasher.same(source, copied))) {
      throw new Error(`copy does not match its source: ${op.from} -> ${op.to}`);
    }
    await IOUtils.move(tmp, to, { noOverwrite: true });
  } catch (e) {
    await removeFile(tmp);
    throw e;
  }
  return { operation: op, status: "done" };
}

/**
 * Old `to` into the plugin trash first, then the content of `from` in its
 * place through a temporary copy. A failure after the old file has moved
 * puts it back.
 */
async function replace(root: string, op: ReplaceOp, hasher: Hasher): Promise<OpResult> {
  const from = resolveInRoot(root, op.from);
  const to = resolveInRoot(root, op.to);
  const backup = resolveReplacedPath(root, op.backup);
  if (pathKey(op.from) === pathKey(op.to)) {
    throw new Skip("same-file", op.to);
  }
  const source = await fileAt(from);
  if (!source) {
    throw new Skip("source-missing", op.from);
  }
  const target = await fileAt(to);
  if (!target) {
    throw new Skip("target-missing", op.to);
  }
  if (await hasher.same(source, target)) {
    return { operation: op, status: "unchanged", reason: "identical" };
  }
  if (await IOUtils.exists(backup)) {
    throw new Skip("backup-exists", op.backup);
  }

  const tmp = to + TEMP_SUFFIX;
  await removeFile(tmp);
  try {
    await IOUtils.copy(from, tmp, { noOverwrite: true });
    const copied = await fileAt(tmp);
    if (!copied || !(await hasher.same(source, copied))) {
      throw new Error(`copy does not match its source: ${op.from} -> ${op.to}`);
    }
    await IOUtils.makeDirectory(PathUtils.parent(backup)!, { createAncestors: true, ignoreExisting: true });
    await IOUtils.move(to, backup, { noOverwrite: true });
  } catch (e) {
    await removeFile(tmp);
    throw e;
  }
  try {
    await IOUtils.move(tmp, to, { noOverwrite: true });
  } catch (e) {
    await IOUtils.move(backup, to, { noOverwrite: true }).catch(() => {});
    await removeFile(tmp);
    throw e;
  }
  return { operation: op, status: "done" };
}

/** One dated folder of replaced versions, with everything in it. */
async function purgeReplaced(root: string, op: PurgeReplacedOp): Promise<OpResult> {
  const path = resolveReplacedPath(root, op.path);
  if (!(await IOUtils.exists(path))) {
    return { operation: op, status: "unchanged", reason: "already-absent" };
  }
  await clearReadOnlyTree(path);
  await IOUtils.remove(path, { recursive: true });
  return { operation: op, status: "done" };
}

/** OneDrive marks files and folders read-only (known_pits B1); removing a tree needs that cleared everywhere. */
async function clearReadOnlyTree(abs: string): Promise<void> {
  if (!Zotero.isWin) {
    return;
  }
  await IOUtils.setWindowsAttributes(abs, { readOnly: false });
  const info = await IOUtils.stat(abs);
  if (info.type === "directory") {
    for (const child of await IOUtils.getChildren(abs)) {
      await clearReadOnlyTree(child);
    }
  }
}

/** Only ever a file carrying the plugin's own temporary suffix. */
async function discardTemp(root: string, op: DiscardTempOp): Promise<OpResult> {
  const path = resolveInRoot(root, op.path);
  if (!op.path.endsWith(TEMP_SUFFIX)) {
    throw new Skip("not-a-temporary-file", op.path);
  }
  if (!(await fileAt(path))) {
    return { operation: op, status: "unchanged", reason: "already-absent" };
  }
  await removeFile(path);
  return { operation: op, status: "done" };
}

async function copy(root: string, op: CopyOp, hasher: Hasher): Promise<OpResult> {
  const from = resolveInRoot(root, op.from);
  const to = resolveInRoot(root, op.to);
  const source = await fileAt(from);
  if (!source) {
    throw new Skip("source-missing", op.from);
  }
  const existing = await fileAt(to);
  if (existing) {
    if (await hasher.same(source, existing)) {
      return { operation: op, status: "unchanged", reason: "identical-copy-exists" };
    }
    throw new Skip("target-exists-differs", op.to);
  }

  // Copy under a temporary name and rename once verified, so that a crash
  // leaves at most a recognisable temporary file, never a half-written copy.
  await IOUtils.makeDirectory(PathUtils.parent(to)!, { createAncestors: true, ignoreExisting: true });
  const tmp = to + TEMP_SUFFIX;
  await removeFile(tmp);
  try {
    await IOUtils.copy(from, tmp, { noOverwrite: true });
    const copied = await fileAt(tmp);
    if (!copied || !(await hasher.same(source, copied))) {
      throw new Error(`copy does not match its source: ${op.from} -> ${op.to}`);
    }
    await IOUtils.move(tmp, to, { noOverwrite: true });
  } catch (e) {
    await removeFile(tmp);
    throw e;
  }
  return { operation: op, status: "done" };
}

/**
 * Deleting is the one irreversible step, so all of these must hold: the
 * copy kept is a different, byte-identical file, and no attachment in the
 * library (trashed ones included) points at the file being deleted.
 */
async function remove(root: string, op: DeleteOp, hasher: Hasher): Promise<OpResult> {
  const path = resolveInRoot(root, op.path);
  const keep = resolveInRoot(root, op.keep);
  if (pathKey(op.path) === pathKey(op.keep)) {
    throw new Skip("keep-is-target", op.path);
  }
  const target = await fileAt(path);
  if (!target) {
    return { operation: op, status: "unchanged", reason: "already-absent" };
  }
  const kept = await fileAt(keep);
  if (!kept) {
    throw new Skip("keep-missing", op.keep);
  }
  if (!(await hasher.same(target, kept))) {
    throw new Skip("keep-differs", op.keep);
  }
  if ((await pointedFiles(root)).has(pathKey(op.path))) {
    throw new Skip("pointed-by-attachment", op.path);
  }
  await removeFile(path);
  if (await IOUtils.exists(path)) {
    throw new Error(`file still exists after deletion: ${op.path}`);
  }
  return { operation: op, status: "done" };
}

async function rename(root: string, op: RenameOp): Promise<OpResult> {
  const from = resolveInRoot(root, op.from);
  const to = resolveInRoot(root, op.to);
  const source = await fileAt(from);
  if (!source) {
    throw new Skip("source-missing", op.from);
  }
  if (op.from === op.to) {
    return { operation: op, status: "unchanged", reason: "same-name" };
  }
  const caseOnly = pathKey(op.from) === pathKey(op.to);
  if (!caseOnly && (await IOUtils.exists(to))) {
    throw new Skip("target-exists", op.to);
  }
  if ((await pointedFiles(root)).has(pathKey(op.from))) {
    throw new Skip("pointed-by-attachment", op.from);
  }
  await IOUtils.makeDirectory(PathUtils.parent(to)!, { createAncestors: true, ignoreExisting: true });
  if (caseOnly) {
    // A case-only rename is a no-op move on case-insensitive file systems.
    const tmp = to + TEMP_SUFFIX;
    await IOUtils.move(from, tmp, { noOverwrite: true });
    await IOUtils.move(tmp, to, { noOverwrite: true });
  } else {
    await IOUtils.move(from, to, { noOverwrite: true });
  }
  if (!(await IOUtils.exists(to))) {
    throw new Error(`renamed file not found: ${op.to}`);
  }
  return { operation: op, status: "done" };
}

/**
 * relinkAttachmentFile() only changes the stored path of a linked file
 * (known_pits A7), except that it renames files whose names Zotero considers
 * invalid; the result is read back to catch that.
 */
async function relink(root: string, op: RelinkOp, hasher: Hasher): Promise<OpResult> {
  const to = resolveInRoot(root, op.to);
  const target = await fileAt(to);
  if (!target) {
    throw new Skip("target-missing", op.to);
  }
  const attachment = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, op.attachmentKey);
  if (
    !attachment ||
    !attachment.isAttachment() ||
    attachment.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_FILE
  ) {
    throw new Skip("not-a-linked-attachment", op.attachmentKey);
  }
  const current = attachment.getFilePath() || null;
  if (current && pathKey(relativeTo(root, current) ?? current) === pathKey(op.to)) {
    return { operation: op, status: "unchanged", reason: "already-pointed" };
  }
  const currentFile = current ? await fileAt(current) : null;
  if (currentFile && !(await hasher.same(currentFile, target))) {
    throw new Skip("current-file-differs", op.to);
  }
  const ok = await attachment.relinkAttachmentFile(to);
  const now = attachment.getFilePath();
  if (!ok || !now || pathKey(relativeTo(root, now) ?? now) !== pathKey(op.to)) {
    throw new Error(`relink not applied: now ${String(now)}, expected ${op.to}`);
  }
  return { operation: op, status: "done" };
}

/**
 * Files under the root that some linked attachment points at, by
 * pathKey(rel); with `liveOnly`, leaving out attachments in the trash
 * (themselves or through their parent).
 */
async function pointedFiles(root: string, options: { liveOnly?: boolean } = {}): Promise<Set<string>> {
  const live = options.liveOnly
    ? " AND itemID NOT IN (SELECT itemID FROM deletedItems)" +
      " AND (parentItemID IS NULL OR parentItemID NOT IN (SELECT itemID FROM deletedItems))"
    : "";
  const rows = (await Zotero.DB.queryAsync(
    `SELECT path FROM itemAttachments WHERE linkMode = ? AND path IS NOT NULL${live}`,
    [Zotero.Attachments.LINK_MODE_LINKED_FILE],
  )) as { path: string }[];
  const keys = new Set<string>();
  for (const { path } of rows) {
    const abs = Zotero.Attachments.resolveRelativePath(path) || path;
    const rel = relativeTo(root, abs);
    if (rel !== null) {
      keys.add(pathKey(rel));
    }
  }
  return keys;
}

async function fileAt(abs: string): Promise<DiskFile | null> {
  try {
    const info = await IOUtils.stat(abs);
    return info.type === "regular" ? { rel: "", abs, size: info.size ?? 0, mtime: info.lastModified ?? 0 } : null;
  } catch (e) {
    // IOUtils rejects with a DOMException named NotFoundError.
    if ((e as { name?: string } | null)?.name === "NotFoundError") {
      return null;
    }
    throw e;
  }
}

/** Remove a file, clearing the read-only attribute OneDrive may have set (known_pits B1). */
async function removeFile(abs: string): Promise<void> {
  if (!(await IOUtils.exists(abs))) {
    return;
  }
  if (Zotero.isWin) {
    await IOUtils.setWindowsAttributes(abs, { readOnly: false });
  }
  await IOUtils.remove(abs);
}
