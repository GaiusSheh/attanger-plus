import { baseOf, collectionFolder, joinRel, relativeTo, toAbsolute } from "../check/paths";
import type { Intent } from "../sync/types";
import { isDryRun } from "../utils/prefs";
import { collectionNames } from "../utils/zotero";
import { l10nID } from "./l10n";
import { showMessages } from "./toast";

const TITLE = "Attanger Plus";

/*
 * "Show File in Current Collection Folder" (requirements §F2): every
 * collection folder holds its own copy, so show the one belonging to the
 * collection being viewed rather than the copy Zotero happens to point at;
 * offer to restore it from another copy when it is missing.
 */

export interface RevealTarget {
  attachment: Zotero.Item;
  path: string;
  /** Set when `path` is the copy in this collection's folder. */
  collection: Zotero.Collection | null;
  exists: boolean;
}

/** The selected attachment itself, or a regular item's best file attachment. */
export async function fileAttachmentsOf(items: Zotero.Item[]): Promise<Zotero.Item[]> {
  const result: Zotero.Item[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    let attachment: Zotero.Item | undefined;
    if (item.isAttachment()) {
      attachment = item.isFileAttachment() ? item : undefined;
    } else if (item.isRegularItem()) {
      attachment = (await item.getBestAttachments()).find((a) => a.isFileAttachment());
    }
    if (attachment && !seen.has(attachment.id)) {
      seen.add(attachment.id);
      result.push(attachment);
    }
  }
  return result;
}

/**
 * The copy of `attachment` in `collection`'s folder; Zotero's own path when
 * there is no such copy to look for (no single collection selected, item not
 * in it, stored file, or file outside the files root).
 */
export async function revealTarget(
  attachment: Zotero.Item,
  collection: Zotero.Collection | null,
): Promise<RevealTarget | null> {
  const pointed = attachment.getFilePath();
  if (!pointed) {
    return null;
  }
  const root = (Zotero.Prefs.get("baseAttachmentPath") as string | undefined) || null;
  const owner = attachment.parentItemID ? Zotero.Items.get(attachment.parentItemID) : attachment;
  const linked = attachment.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE;
  const rel = root && linked ? relativeTo(root, pointed) : null;
  if (collection && root && rel !== null && owner && owner.inCollection(collection.id)) {
    const path = toAbsolute(root, joinRel(collectionFolder(collectionNames(collection)), baseOf(rel)));
    return { attachment, path, collection, exists: await IOUtils.exists(path) };
  }
  return { attachment, path: pointed, collection: null, exists: await IOUtils.exists(pointed) };
}

/** Reveal each selected item's file; report the missing ones in one dialog. */
export async function showInCollectionFolder(items: Zotero.Item[], collection: Zotero.Collection | null): Promise<void> {
  const targets: RevealTarget[] = [];
  for (const attachment of await fileAttachmentsOf(items)) {
    const target = await revealTarget(attachment, collection);
    if (target) {
      targets.push(target);
    }
  }
  const missing = targets.filter((t) => !t.exists);
  for (const target of targets.filter((t) => t.exists)) {
    await Zotero.File.reveal(target.path);
  }
  if (missing.length) {
    await handleMissing(missing);
  }
}

/**
 * A copy missing from the viewed collection's folder can be restored from
 * another copy (requirements §F2); other missing files are only reported.
 */
async function handleMissing(missing: RevealTarget[]): Promise<void> {
  const win = Zotero.getMainWindow();
  const parent = win as unknown as mozIDOMWindowProxy;
  const text = (id: Parameters<typeof l10nID>[0], args?: Record<string, string | number>) =>
    win.document.l10n!.formatValue(l10nID(id), args) as Promise<string>;
  const lines = await Promise.all(
    missing.map((t) =>
      t.collection
        ? text("reveal-missing-copy", { file: PathUtils.filename(t.path), collection: collectionNames(t.collection).join("/") })
        : text("reveal-missing-file", { file: t.path }),
    ),
  );
  const restorable: RevealTarget[] = [];
  for (const t of missing) {
    if (t.collection && (await hasOtherCopy(t))) {
      restorable.push(t);
    }
  }
  if (!restorable.length) {
    // Nothing to decide: say it in the corner (§F9).
    showMessages(lines, true);
    return;
  }

  // Interface constants; the typings declare them optional.
  const ps = Ci.nsIPromptService;
  const flags = ps.BUTTON_POS_0! * ps.BUTTON_TITLE_IS_STRING! + ps.BUTTON_POS_1! * ps.BUTTON_TITLE_CANCEL!;
  const message = [...lines, await text("reveal-restore-prompt", { count: restorable.length })].join("\n\n");
  // A null check-box label means no check box; the typings do not allow it.
  const noCheckBox = null as unknown as string;
  const button = Services.prompt.confirmEx(parent, TITLE, message, flags, await text("reveal-restore-button"), "", "", noCheckBox, {
    value: false,
  });
  if (button !== 0) {
    return;
  }
  const { restored, failed, dryRun } = await restoreCopies(restorable);
  for (const t of restored) {
    await Zotero.File.reveal(t.path);
  }
  const notes = dryRun
    ? [await text("reveal-restore-dry-run")]
    : await Promise.all(failed.map((t) => text("reveal-restore-failed", { file: PathUtils.filename(t.path) })));
  showMessages(notes, !dryRun);
}

/**
 * Make the missing copies in the viewed collections' folders from another
 * copy, through the running plugin's copy maintenance (so it is logged,
 * honours dry-run mode and waits for any reconciling in progress).
 */
export async function restoreCopies(
  targets: RevealTarget[],
): Promise<{ restored: RevealTarget[]; failed: RevealTarget[]; dryRun: boolean }> {
  const sync = Zotero.AttangerPlus?.sync;
  if (!sync) {
    throw new Error("Attanger Plus is not running");
  }
  const requests = new Map<string, Intent>();
  for (const t of targets) {
    if (!t.collection) {
      continue;
    }
    const key = ownerOf(t.attachment).key;
    const intent = requests.get(key) ?? { addedTo: [] };
    intent.addedTo!.push(t.collection.id);
    requests.set(key, intent);
  }
  await sync.reconcileNow(requests);
  const restored: RevealTarget[] = [];
  const failed: RevealTarget[] = [];
  for (const t of targets) {
    ((await IOUtils.exists(t.path)) ? restored : failed).push(t);
  }
  return { restored, failed, dryRun: isDryRun() };
}

/** Whether the file exists somewhere else to restore from: Zotero's own copy, or a copy in another of the item's folders. */
async function hasOtherCopy(t: RevealTarget): Promise<boolean> {
  const pointed = t.attachment.getFilePath();
  if (pointed && (await IOUtils.exists(pointed))) {
    return true;
  }
  for (const id of ownerOf(t.attachment).getCollections()) {
    const other = await revealTarget(t.attachment, Zotero.Collections.get(id) as Zotero.Collection);
    if (other?.collection && other.exists) {
      return true;
    }
  }
  return false;
}

function ownerOf(attachment: Zotero.Item): Zotero.Item {
  return (attachment.parentItemID ? Zotero.Items.get(attachment.parentItemID) : attachment) as Zotero.Item;
}

/** The collection being viewed, when exactly one is selected. */
export function currentCollection(): Zotero.Collection | null {
  const pane = Zotero.getActiveZoteroPane();
  const selected = pane?.getSelectedCollections() ?? [];
  return selected.length === 1 ? selected[0] : null;
}

/** Whether the menu item can do anything for these items (cheap check for menu showing). */
export function hasFiles(items: Zotero.Item[]): boolean {
  return items.some((item) =>
    item.isAttachment() ? item.isFileAttachment() : item.isRegularItem() && item.numAttachments() > 0,
  );
}
