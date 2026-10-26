import { templateBaseName } from "../utils/zotero";
import { testLibraryPaths } from "./paths";
import { makePdf } from "./pdf";

/*
 * Test library: one positive case per check (C1–C12, C14; requirements §F1.1)
 * next to cases that must NOT be reported. Folders are relative to the files
 * root and use "/"; file contents are given as a text seed, so two files with
 * the same seed are byte-identical copies.
 */

interface CopySpec {
  folder: string;
  seed: string;
}

interface AttachmentSpec {
  /** "{template}" is replaced by Zotero's file name for the parent item. */
  file: string;
  /** Folder of the copy Zotero points at. */
  folder: string;
  seed: string;
  /** Copies in other folders. */
  copies?: CopySpec[];
  /** Delete the pointed file after linking. */
  missing?: boolean;
  /** Import into Zotero storage instead of linking. */
  stored?: boolean;
}

interface ItemSpec {
  name: string;
  type?: "journalArticle" | "webpage";
  title: string;
  doi?: string;
  collections: string[];
  attachments?: AttachmentSpec[];
  trashed?: boolean;
}

interface ExtraFileSpec {
  path: string;
  seed: string;
}

export const COLLECTIONS = [
  "Physics",
  "Physics/Optics",
  "Physics/Plasma",
  "Physics/Empty",
  "Chemistry",
  "Notes Only",
];

/** Collections that deliberately have no folder (C9). */
const COLLECTIONS_WITHOUT_FOLDER = ["Notes Only"];

export const ITEMS: ItemSpec[] = [
  // Clean cases: nothing may be reported for these. Their files follow
  // Zotero's file naming template, so C12 must stay quiet as well.
  {
    name: "ok-single",
    title: "Clean Single Collection Item",
    collections: ["Physics/Optics"],
    attachments: [{ file: "{template}.pdf", folder: "Physics/Optics", seed: "ok-single" }],
  },
  {
    name: "ok-multi",
    title: "Clean Multi Collection Item",
    collections: ["Physics/Optics", "Chemistry"],
    attachments: [
      {
        file: "{template}.pdf",
        folder: "Physics/Optics",
        seed: "ok-multi",
        copies: [{ folder: "Chemistry", seed: "ok-multi" }],
      },
    ],
  },
  {
    name: "ok-suffix",
    title: "Clean Item With Arxiv Version",
    collections: ["Chemistry"],
    attachments: [
      { file: "{template}.pdf", folder: "Chemistry", seed: "ok-suffix" },
      { file: "{template} - arxiv.pdf", folder: "Chemistry", seed: "ok-suffix-arxiv" },
    ],
  },
  {
    name: "ok-notes-only",
    title: "Item Without Attachments",
    collections: ["Notes Only"],
  },

  // C1 not in any collection
  { name: "c1-unfiled", title: "Unfiled Item", collections: [] },

  // C2 directly in a collection that has subcollections
  {
    name: "c2-parent-direct",
    title: "Item Directly In Parent Collection",
    collections: ["Physics"],
    attachments: [{ file: "Parent Direct.pdf", folder: "Physics", seed: "c2" }],
  },

  // C3 file missing: one copy left / none left
  {
    name: "c3-pointed-missing",
    title: "Pointed Copy Missing",
    collections: ["Physics/Optics", "Chemistry"],
    attachments: [
      {
        file: "Pointed Missing.pdf",
        folder: "Physics/Optics",
        seed: "c3-pointed",
        missing: true,
        copies: [{ folder: "Chemistry", seed: "c3-pointed" }],
      },
    ],
  },
  {
    name: "c3-all-missing",
    title: "All Copies Missing",
    collections: ["Chemistry"],
    attachments: [{ file: "All Missing.pdf", folder: "Chemistry", seed: "c3-all", missing: true }],
  },

  // C4 copy missing / copy differs
  {
    name: "c4-copy-missing",
    title: "Copy Missing In Second Collection",
    collections: ["Physics/Optics", "Physics/Plasma"],
    attachments: [{ file: "Copy Missing.pdf", folder: "Physics/Optics", seed: "c4-missing" }],
  },
  {
    name: "c4-copy-differs",
    title: "Copy Differs In Second Collection",
    collections: ["Physics/Optics", "Chemistry"],
    attachments: [
      {
        file: "Copy Differs.pdf",
        folder: "Physics/Optics",
        seed: "c4-differs",
        copies: [{ folder: "Chemistry", seed: "c4-differs-edited" }],
      },
    ],
  },

  // C5 pointed copy outside all of the item's collection folders
  {
    name: "c5-misplaced",
    title: "Misplaced File",
    collections: ["Chemistry"],
    attachments: [{ file: "Misplaced.pdf", folder: "Physics/Optics", seed: "c5" }],
  },

  // C6 stored attachment
  {
    name: "c6-stored",
    title: "Stored Attachment",
    collections: ["Chemistry"],
    attachments: [{ file: "Stored.pdf", folder: "", seed: "c6", stored: true }],
  },

  // C10 duplicates by DOI and by normalized title
  {
    name: "c10-doi-a",
    title: "Duplicate By DOI First",
    doi: "10.1234/attanger-plus.fixture",
    collections: ["Chemistry"],
    attachments: [{ file: "Doi A.pdf", folder: "Chemistry", seed: "c10-doi-a" }],
  },
  {
    name: "c10-doi-b",
    title: "Duplicate By DOI Second",
    doi: "10.1234/ATTANGER-PLUS.FIXTURE",
    collections: ["Chemistry"],
    attachments: [{ file: "Doi B.pdf", folder: "Chemistry", seed: "c10-doi-b" }],
  },
  {
    name: "c10-title-a",
    title: "Thermal Transport in Plasmas",
    collections: ["Physics/Plasma"],
    attachments: [{ file: "Thermal A.pdf", folder: "Physics/Plasma", seed: "c10-title-a" }],
  },
  {
    name: "c10-title-b",
    title: "Thermal transport in plasmas.",
    collections: ["Physics/Plasma"],
    attachments: [{ file: "Thermal B.pdf", folder: "Physics/Plasma", seed: "c10-title-b" }],
  },

  // C11 webpage snapshot of an article that exists as a proper item
  {
    name: "c11-article",
    title: "Light Scattering Basics",
    collections: ["Physics/Optics"],
    attachments: [{ file: "Light Scattering.pdf", folder: "Physics/Optics", seed: "c11" }],
  },
  {
    name: "c11-webpage",
    type: "webpage",
    title: "Light Scattering Basics | Journal of Fixture Optics",
    collections: ["Physics/Optics"],
  },

  // C12 duplicate-download suffixes
  {
    name: "c12-space-2",
    title: "Suffix Space Two",
    collections: ["Chemistry"],
    attachments: [{ file: "Suffix 2.pdf", folder: "Chemistry", seed: "c12-2" }],
  },
  {
    name: "c12-paren-1",
    title: "Suffix Paren One",
    collections: ["Chemistry"],
    attachments: [{ file: "Suffix (1).pdf", folder: "Chemistry", seed: "c12-1" }],
  },

  // status.py: byte-identical attachments on the same item
  {
    name: "same-item-dup",
    title: "Same Item Duplicate Attachments",
    collections: ["Chemistry"],
    attachments: [
      { file: "Dup A.pdf", folder: "Chemistry", seed: "same-item-dup" },
      { file: "Dup B.pdf", folder: "Chemistry", seed: "same-item-dup" },
    ],
  },

  // In Zotero's trash; its file is still in the collection folder (C14 later)
  {
    name: "trashed",
    title: "Trashed Item",
    collections: ["Chemistry"],
    attachments: [{ file: "Trashed.pdf", folder: "Chemistry", seed: "trashed" }],
    trashed: true,
  },
];

export const EXTRA_FILES: ExtraFileSpec[] = [
  // C7 orphans: a copy of an attachment file, and a file with unique content
  { path: "Chemistry/Orphan Copy.pdf", seed: "ok-single" },
  { path: "Chemistry/Orphan Unique.pdf", seed: "orphan-unique" },
  // C8 stray folder that also holds an orphan
  { path: "Physics/Renamed/Stale.pdf", seed: "stale" },
  // C14 plugin-trash entry without a trashed item
  { path: ".attanger-plus-trash/ZZZZZZZZ/Ghost.pdf", seed: "ghost" },
];

/** C8 stray folders that are empty. */
export const EXTRA_EMPTY_FOLDERS = ["Old Folder"];

// There is no C13: it relied on an external link manager and was dropped.

export interface TestLibrary {
  dataDir: string;
  root: string;
  collections: Record<string, string>;
  items: Record<string, string>;
}

/** Wipe the dev/test library and its files root, then rebuild the fixtures. */
export async function resetTestLibrary(): Promise<TestLibrary> {
  const paths = testLibraryPaths();
  return withSyncPaused(() => withAttangerPaused(() => buildTestLibrary(paths)));
}

/**
 * The plugin's own copy maintenance would react to the fixtures being built
 * (and fill in the copies they deliberately lack). The running plugin's
 * instance is reached through the global: test bundles import their own
 * copies of the modules.
 */
async function withSyncPaused<T>(fn: () => Promise<T>): Promise<T> {
  const sync = Zotero.AttangerPlus?.sync;
  if (!sync) {
    return fn();
  }
  await sync.pause();
  try {
    return await fn();
  } finally {
    // Let the last Notifier events arrive while still paused.
    await Zotero.Promise.delay(200);
    sync.resume();
  }
}

const ATTANGER_ID = "zoteroattanger@polygon.org";

/**
 * Attanger renames new attachments and turns stored ones into linked files
 * (known_pits A3), which would undo fixtures such as the C6 stored file or
 * the C12 names. It has no working on/off preference, so disable the plugin
 * itself while the fixtures are built; its shutdown drops anything queued.
 * The test runner's profile has no Attanger, so there this does nothing.
 */
async function withAttangerPaused<T>(fn: () => Promise<T>): Promise<T> {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const attanger = await AddonManager.getAddonByID(ATTANGER_ID);
  if (!attanger?.isActive) {
    return fn();
  }
  await attanger.disable();
  try {
    return await fn();
  } finally {
    await attanger.enable();
  }
}

async function buildTestLibrary({ dataDir, root }: { dataDir: string; root: string }): Promise<TestLibrary> {
  const libraryID = Zotero.Libraries.userLibraryID;

  await wipeLibrary(libraryID);
  await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
  await IOUtils.makeDirectory(root, { createAncestors: true });
  Zotero.Prefs.set("baseAttachmentPath", root);
  Zotero.Prefs.set("saveRelativeAttachmentPath", true);

  const collectionIDs: Record<string, number> = {};
  const collectionKeys: Record<string, string> = {};
  for (const path of COLLECTIONS) {
    const parts = path.split("/");
    const parentPath = parts.slice(0, -1).join("/");
    const collection = new Zotero.Collection({
      libraryID,
      name: parts[parts.length - 1],
      parentID: parentPath ? collectionIDs[parentPath] : undefined,
    });
    await collection.saveTx();
    collectionIDs[path] = collection.id;
    collectionKeys[path] = collection.key;
    if (!COLLECTIONS_WITHOUT_FOLDER.includes(path)) {
      await IOUtils.makeDirectory(abs(root, path), { createAncestors: true });
    }
  }

  const itemKeys: Record<string, string> = {};
  for (const spec of ITEMS) {
    const item = new Zotero.Item(spec.type ?? "journalArticle");
    item.libraryID = libraryID;
    item.setField("title", spec.title);
    if (spec.doi) {
      item.setField("DOI", spec.doi);
    }
    item.setCollections(spec.collections.map((p) => collectionIDs[p]));
    await item.saveTx();
    for (const att of spec.attachments ?? []) {
      const file = att.file.replace("{template}", templateBaseName(item));
      await addAttachment(root, item.id, { ...att, file });
    }
    if (spec.trashed) {
      item.deleted = true;
      await item.saveTx();
    }
    itemKeys[spec.name] = item.key;
  }

  for (const extra of EXTRA_FILES) {
    await writePdf(abs(root, extra.path), extra.seed);
  }
  for (const folder of EXTRA_EMPTY_FOLDERS) {
    await IOUtils.makeDirectory(abs(root, folder), { createAncestors: true });
  }

  return { dataDir, root, collections: collectionKeys, items: itemKeys };
}

async function wipeLibrary(libraryID: number): Promise<void> {
  const itemIDs = await Zotero.Items.getAll(libraryID, false, true, true);
  if (itemIDs.length) {
    await Zotero.Items.erase(itemIDs);
  }
  // Erasing a collection erases its subcollections, so repeat until none is
  // left rather than relying on the listing order.
  // zotero-types lacks the third (includeTrashed) parameter.
  const listAll = () =>
    (Zotero.Collections.getByLibrary as (lib: number, recursive: boolean, includeTrashed: boolean) => Zotero.Collection[])
      .call(Zotero.Collections, libraryID, true, true);
  for (let round = 0; round < 10; round++) {
    const collections = listAll();
    if (!collections.length) {
      return;
    }
    for (const collection of collections) {
      if (Zotero.Collections.exists(collection.id)) {
        await collection.eraseTx();
      }
    }
  }
  const left = listAll().length;
  throw new Error(`Could not erase all collections: ${left} left`);
}

async function addAttachment(root: string, parentItemID: number, att: AttachmentSpec): Promise<void> {
  if (att.stored) {
    const tmpDir = PathUtils.join(PathUtils.tempDir, `attanger-plus-${Date.now()}`);
    const tmp = PathUtils.join(tmpDir, att.file);
    await writePdf(tmp, att.seed);
    try {
      await Zotero.Attachments.importFromFile({ file: tmp, parentItemID, contentType: "application/pdf" });
    } finally {
      await IOUtils.remove(tmpDir, { recursive: true, ignoreAbsent: true });
    }
    return;
  }
  const path = abs(root, att.folder, att.file);
  await writePdf(path, att.seed);
  await Zotero.Attachments.linkFromFile({
    file: path,
    parentItemID,
    title: att.file,
    contentType: "application/pdf",
  });
  for (const copy of att.copies ?? []) {
    await writePdf(abs(root, copy.folder, att.file), copy.seed);
  }
  if (att.missing) {
    await IOUtils.remove(path);
  }
}

async function writePdf(path: string, seed: string): Promise<void> {
  await IOUtils.makeDirectory(PathUtils.parent(path)!, { createAncestors: true });
  await IOUtils.write(path, makePdf(`attanger-plus fixture: ${seed}`), { mode: "create" });
}

function abs(root: string, ...relative: string[]): string {
  const parts = relative.flatMap((r) => r.split("/")).filter(Boolean);
  return parts.length ? PathUtils.join(root, ...parts) : root;
}
