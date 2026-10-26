import { Hasher } from "../check/hash";
import { pathKey, relativeTo } from "../check/paths";
import { TEMP_SUFFIX, type DiskFile } from "../check/snapshot";
import { isDryRun } from "../utils/prefs";
import { resolveInRoot, Skip, writableRoot } from "./guard";
import { appendLog } from "./log";
import type { CopyOp, DeleteOp, Operation, OpResult, RelinkOp, RenameOp } from "./types";

/*
 * Carry out planned operations one at a time. Each re-checks its
 * preconditions against the disk and the library as they are now (the plan
 * may be stale), never overwrites a file, verifies its result, and is logged.
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
  return { operation, status: "dry-run" };
}

function pathsOf(operation: Operation): string[] {
  switch (operation.op) {
    case "copy":
    case "rename":
      return [operation.from, operation.to];
    case "delete":
      return [operation.path, operation.keep];
    case "relink":
      return [operation.to];
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
  }
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

/** Files under the root that some linked attachment points at, by pathKey(rel). */
async function pointedFiles(root: string): Promise<Set<string>> {
  const rows = (await Zotero.DB.queryAsync("SELECT path FROM itemAttachments WHERE linkMode = ? AND path IS NOT NULL", [
    Zotero.Attachments.LINK_MODE_LINKED_FILE,
  ])) as { path: string }[];
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
