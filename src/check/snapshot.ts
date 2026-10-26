import { collectionFolder, joinRel, pathKey, relativeTo } from "./paths";

/** Plugin trash folder directly under the files root (requirements §F4). */
export const PLUGIN_TRASH = ".attanger-plus-trash";

/**
 * Suffix of the temporary file a copy is written to before it gets its real
 * name (src/sync/ops.ts). One left behind by a crash is not an orphan.
 */
export const TEMP_SUFFIX = ".attanger-plus-tmp";

/** System files that are never reported. Compared in lower case. */
const IGNORED_FILES = new Set(["desktop.ini", "thumbs.db", ".ds_store"]);

/** Deeper than any real collection tree; guards against link loops. */
const MAX_DEPTH = 64;

export interface CollectionInfo {
  id: number;
  key: string;
  /** Display path, e.g. "Physics/Optics". */
  path: string;
  /** Folder relative to the files root. */
  folder: string;
  folderKey: string;
  childIDs: number[];
}

export type LinkMode = "linked" | "stored" | "snapshot" | "other";

export interface AttachmentInfo {
  key: string;
  title: string;
  linkMode: LinkMode;
  /** Trashed itself or through its parent. */
  deleted: boolean;
  /** Absolute file path (linked files only). */
  abs: string | null;
  /** Path relative to the files root, null when outside it or unknown. */
  rel: string | null;
}

/** A top-level item: a regular item, or a standalone attachment. */
export interface EntryInfo {
  item: Zotero.Item;
  key: string;
  title: string;
  itemType: string;
  doi: string;
  deleted: boolean;
  standalone: boolean;
  /** Collections that are not in the trash. */
  collectionIDs: number[];
  attachments: AttachmentInfo[];
}

export interface DiskFile {
  rel: string;
  abs: string;
  size: number;
  mtime: number;
}

export interface Snapshot {
  root: string;
  collections: Map<number, CollectionInfo>;
  entries: EntryInfo[];
  /** Files outside the plugin trash, by pathKey(rel). */
  files: Map<string, DiskFile>;
  /** Folders outside the plugin trash: pathKey(rel) -> rel. */
  folders: Map<string, string>;
  /** Plugin trash: name of each subfolder ("" for loose files) -> its files. */
  trash: Map<string, DiskFile[]>;
}

export async function takeSnapshot(root: string): Promise<Snapshot> {
  const library = await readLibrary(root);
  const disk = await readDisk(root);
  return { root, ...library, ...disk };
}

/** Collections and items only; without a root no attachment gets a relative path. */
export async function readLibrary(root: string | null): Promise<Pick<Snapshot, "collections" | "entries">> {
  const libraryID = Zotero.Libraries.userLibraryID;
  return {
    collections: readCollections(libraryID),
    entries: await readEntries(libraryID, root),
  };
}

function readCollections(libraryID: number): Map<number, CollectionInfo> {
  // Collections in the trash are left out, as Zotero does for item membership.
  const active = Zotero.Collections.getByLibrary(libraryID, true);
  const byID = new Map(active.map((c) => [c.id, c]));
  const result = new Map<number, CollectionInfo>();
  for (const collection of active) {
    const names: string[] = [];
    for (let c: Zotero.Collection | undefined = collection; c; ) {
      names.unshift(c.name);
      c = c.parentID ? byID.get(c.parentID) : undefined;
    }
    const folder = collectionFolder(names);
    result.set(collection.id, {
      id: collection.id,
      key: collection.key,
      path: names.join("/"),
      folder,
      folderKey: pathKey(folder),
      childIDs: active.filter((c) => c.parentID === collection.id).map((c) => c.id),
    });
  }
  return result;
}

async function readEntries(libraryID: number, root: string | null): Promise<EntryInfo[]> {
  const items = await Zotero.Items.getAll(libraryID, false, true);
  await Zotero.Items.loadDataTypes(items);
  const entries: EntryInfo[] = [];
  for (const item of items) {
    const standalone = item.isAttachment() && !item.parentItemID;
    if (!item.isRegularItem() && !standalone) {
      continue;
    }
    const attachmentItems = standalone
      ? [item]
      : (Zotero.Items.get(item.getAttachments(true)) as Zotero.Item[]);
    entries.push({
      item,
      key: item.key,
      title: field(item, "title"),
      itemType: item.itemType,
      doi: field(item, "DOI"),
      deleted: item.deleted,
      standalone,
      collectionIDs: item.getCollections(),
      attachments: attachmentItems.map((att) => readAttachment(att, item.deleted, root)),
    });
  }
  return entries;
}

function readAttachment(att: Zotero.Item, parentDeleted: boolean, root: string | null): AttachmentInfo {
  const modes = Zotero.Attachments;
  let linkMode: LinkMode = "other";
  switch (att.attachmentLinkMode) {
    case modes.LINK_MODE_LINKED_FILE:
      linkMode = "linked";
      break;
    case modes.LINK_MODE_IMPORTED_FILE:
      linkMode = "stored";
      break;
    case modes.LINK_MODE_IMPORTED_URL:
      linkMode = "snapshot";
      break;
  }
  const abs = linkMode === "linked" ? att.getFilePath() || null : null;
  return {
    key: att.key,
    title: field(att, "title"),
    linkMode,
    deleted: att.deleted || parentDeleted,
    abs,
    rel: abs && root ? relativeTo(root, abs) : null,
  };
}

/** getField() for a field the item type lacks yields "" rather than throwing. */
function field(item: Zotero.Item, name: string): string {
  try {
    return String(item.getField(name as _ZoteroTypes.Item.ItemField) ?? "");
  } catch {
    return "";
  }
}

async function readDisk(root: string) {
  const files = new Map<string, DiskFile>();
  const folders = new Map<string, string>();
  const trash = new Map<string, DiskFile[]>();

  async function walk(abs: string, rel: string, depth: number, onFile: (f: DiskFile) => void, inTrash: boolean) {
    if (depth > MAX_DEPTH) {
      throw new Error(`Folder nesting deeper than ${MAX_DEPTH} levels (link loop?): ${abs}`);
    }
    for (const child of await IOUtils.getChildren(abs)) {
      const name = PathUtils.filename(child);
      const childRel = joinRel(rel, name);
      const info = await IOUtils.stat(child);
      if (info.type === "directory") {
        if (!inTrash && depth === 0 && name === PLUGIN_TRASH) {
          await walkTrash(child);
          continue;
        }
        if (!inTrash) {
          folders.set(pathKey(childRel), childRel);
        }
        await walk(child, childRel, depth + 1, onFile, inTrash);
      } else if (info.type === "regular" && !isIgnoredFile(name)) {
        onFile({ rel: childRel, abs: child, size: info.size ?? 0, mtime: info.lastModified ?? 0 });
      }
    }
  }

  async function walkTrash(trashAbs: string) {
    for (const child of await IOUtils.getChildren(trashAbs)) {
      const name = PathUtils.filename(child);
      const info = await IOUtils.stat(child);
      const bucket = info.type === "directory" ? name : "";
      const list = trash.get(bucket) ?? [];
      trash.set(bucket, list);
      const rel = joinRel(PLUGIN_TRASH, name);
      if (info.type === "directory") {
        await walk(child, rel, 1, (f) => list.push(f), true);
      } else if (info.type === "regular" && !isIgnoredFile(name)) {
        list.push({ rel, abs: child, size: info.size ?? 0, mtime: info.lastModified ?? 0 });
      }
    }
  }

  await walk(root, "", 0, (f) => files.set(pathKey(f.rel), f), false);
  return { files, folders, trash };
}

function isIgnoredFile(name: string): boolean {
  return IGNORED_FILES.has(name.toLowerCase()) || name.startsWith("~$") || name.endsWith(TEMP_SUFFIX);
}
