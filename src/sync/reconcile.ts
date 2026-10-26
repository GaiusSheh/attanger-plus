import { linked } from "../check/checks";
import { Hasher } from "../check/hash";
import { baseOf, dirOf, pathKey, relativeTo } from "../check/paths";
import { readTrash, takeSnapshot, type EntryInfo } from "../check/snapshot";
import { log } from "../utils/log";
import { isDryRun } from "../utils/prefs";
import { purgeOps } from "./changes";
import { writableRoot } from "./guard";
import { execute } from "./ops";
import { planEntry } from "./plan";
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
  await state.save();
  return { tempFiles, purged, recorded, forgotten };
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
