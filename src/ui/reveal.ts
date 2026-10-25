import { baseOf, collectionFolder, joinRel, relativeTo, toAbsolute } from "../check/paths";
import { l10nID } from "./l10n";

/*
 * "Show File in Current Collection Folder" (requirements §F2, read-only part):
 * every collection folder holds its own copy, so show the one belonging to
 * the collection being viewed rather than the copy Zotero happens to point at.
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
    const path = toAbsolute(root, joinRel(collectionFolder(namesOf(collection)), baseOf(rel)));
    return { attachment, path, collection, exists: await IOUtils.exists(path) };
  }
  return { attachment, path: pointed, collection: null, exists: await IOUtils.exists(pointed) };
}

/** Reveal each selected item's file; report the missing ones in one alert. */
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
    const win = Zotero.getMainWindow();
    const lines = await Promise.all(
      missing.map((t) =>
        t.collection
          ? win.document.l10n!.formatValue(l10nID("reveal-missing-copy"), {
              file: PathUtils.filename(t.path),
              collection: namesOf(t.collection).join("/"),
            })
          : win.document.l10n!.formatValue(l10nID("reveal-missing-file"), { file: t.path }),
      ),
    );
    Services.prompt.alert(win as unknown as mozIDOMWindowProxy, "Attanger Plus", lines.join("\n\n"));
  }
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

function namesOf(collection: Zotero.Collection): string[] {
  const names: string[] = [];
  for (let c: Zotero.Collection | false = collection; c; c = c.parentID ? Zotero.Collections.get(c.parentID) : false) {
    names.unshift(c.name);
  }
  return names;
}
