import { templateBaseName } from "../utils/zotero";
import type { Hasher } from "./hash";
import { baseOf, dirOf, joinRel, pathKey } from "./paths";
import type { AttachmentInfo, CollectionInfo, DiskFile, EntryInfo, Snapshot } from "./snapshot";
import { COLLECTIONS_BUCKET, PLUGIN_TRASH, SET_ASIDE_BUCKETS } from "./snapshot";
import type { Issue } from "./types";

/*
 * Each check reads the snapshot only. Definitions: requirements §F1.1.
 * "Active" means not in Zotero's trash.
 */

/** Library-only checks; they need no files root. */
export function checkLibrary(s: Pick<Snapshot, "collections" | "entries">): Issue[] {
  return [
    ...checkUnfiled(s),
    ...checkParentCollection(s),
    ...checkStored(s),
    ...checkDuplicates(s),
    ...checkWebpageSnapshots(s),
  ];
}

export async function checkFiles(s: Snapshot, hasher: Hasher): Promise<Issue[]> {
  return [
    ...(await checkLinkedFiles(s, hasher)),
    ...(await checkOrphans(s, hasher)),
    ...checkStrayFolders(s),
    ...checkCollectionFolders(s),
    ...checkFileNames(s),
    ...checkTrash(s),
  ];
}

// ---------------------------------------------------------------- helpers

function activeEntries(s: Pick<Snapshot, "entries">): EntryInfo[] {
  return s.entries.filter((e) => !e.deleted);
}

export function collectionsOf(s: Pick<Snapshot, "collections">, e: EntryInfo): CollectionInfo[] {
  return e.collectionIDs.map((id) => s.collections.get(id)).filter((c): c is CollectionInfo => !!c);
}

export function linked(e: EntryInfo): AttachmentInfo[] {
  return e.attachments.filter((a) => a.linkMode === "linked" && !a.deleted);
}

function itemFields(e: EntryInfo): Pick<Issue, "itemKey" | "itemTitle"> {
  return { itemKey: e.key, itemTitle: e.title };
}

function collectionFields(c: CollectionInfo): Pick<Issue, "collectionKey" | "collectionPath"> {
  return { collectionKey: c.key, collectionPath: c.path };
}

// ------------------------------------------------------------- C1, C2, C6

/** C1: active items in no collection. */
function checkUnfiled(s: Pick<Snapshot, "collections" | "entries">): Issue[] {
  return activeEntries(s)
    .filter((e) => collectionsOf(s, e).length === 0)
    .map((e) => ({ check: "C1", kind: "unfiled", severity: "problem", ...itemFields(e) }));
}

/** C2: items placed directly in a collection that has subcollections. */
function checkParentCollection(s: Pick<Snapshot, "collections" | "entries">): Issue[] {
  const issues: Issue[] = [];
  for (const e of activeEntries(s)) {
    for (const c of collectionsOf(s, e)) {
      if (c.childIDs.length) {
        issues.push({
          check: "C2",
          kind: "in-parent-collection",
          severity: "problem",
          ...itemFields(e),
          ...collectionFields(c),
        });
      }
    }
  }
  return issues;
}

/** C6: stored files and web snapshots kept in Zotero's storage. */
function checkStored(s: Pick<Snapshot, "entries">): Issue[] {
  const issues: Issue[] = [];
  for (const e of activeEntries(s)) {
    for (const a of e.attachments) {
      if (!a.deleted && (a.linkMode === "stored" || a.linkMode === "snapshot")) {
        issues.push({
          check: "C6",
          kind: a.linkMode,
          severity: "problem",
          ...itemFields(e),
          attachmentKey: a.key,
          related: [a.title],
        });
      }
    }
  }
  return issues;
}

// ------------------------------------------------------------- C3, C4, C5

/**
 * C3 missing files, C4 missing or differing copies, C5 files outside the
 * item's collection folders. C4 is skipped for a misplaced file (C5 already
 * says where it should be) and for items in no collection (C1).
 */
async function checkLinkedFiles(s: Snapshot, hasher: Hasher): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const e of activeEntries(s)) {
    const cols = collectionsOf(s, e);
    for (const a of linked(e)) {
      const base = { ...itemFields(e), attachmentKey: a.key };
      if (!a.abs) {
        issues.push({ check: "C3", kind: "no-path", severity: "problem", ...base });
        continue;
      }
      if (a.rel === null) {
        issues.push({ check: "C5", kind: "outside-root", severity: "problem", ...base, path: a.abs });
        if (!(await IOUtils.exists(a.abs))) {
          issues.push({ check: "C3", kind: "all-missing", severity: "problem", ...base, path: a.abs });
        }
        continue;
      }

      const pointed = s.files.get(pathKey(a.rel));
      const pointedFolderKey = pathKey(dirOf(a.rel));
      const inOwnFolder = cols.some((c) => c.folderKey === pointedFolderKey);
      if (cols.length && !inOwnFolder) {
        issues.push({
          check: "C5",
          kind: "misplaced",
          severity: "problem",
          ...base,
          path: a.rel,
          related: cols.map((c) => c.folder),
        });
      }
      if (!cols.length || !inOwnFolder) {
        if (!pointed) {
          issues.push({ check: "C3", kind: "all-missing", severity: "problem", ...base, path: a.rel });
        }
        continue;
      }

      const name = baseOf(a.rel);
      const copies = uniqueFolders(cols)
        .filter((c) => c.folderKey !== pointedFolderKey)
        .map((c) => {
          const rel = joinRel(c.folder, name);
          return { collection: c, rel, file: s.files.get(pathKey(rel)) };
        });

      let reference: DiskFile | undefined = pointed;
      if (!pointed) {
        const present = copies.filter((c) => c.file).map((c) => c.file!);
        if (!present.length) {
          issues.push({ check: "C3", kind: "all-missing", severity: "problem", ...base, path: a.rel });
          continue;
        }
        issues.push({
          check: "C3",
          kind: "pointed-missing",
          severity: "problem",
          ...base,
          path: a.rel,
          related: present.map((f) => f.rel),
        });
        reference = present[0];
      }

      for (const copy of copies) {
        if (copy.file === reference) {
          continue;
        }
        const where = { ...base, ...collectionFields(copy.collection), path: copy.rel, related: [reference!.rel] };
        if (!copy.file) {
          issues.push({ check: "C4", kind: "copy-missing", severity: "problem", ...where });
        } else if (!(await hasher.same(copy.file, reference!))) {
          issues.push({ check: "C4", kind: "copy-differs", severity: "problem", ...where });
        }
      }
    }
  }
  return issues;
}

/** One collection per folder (two collections can map to the same folder). */
export function uniqueFolders(cols: CollectionInfo[]): CollectionInfo[] {
  const seen = new Set<string>();
  return cols.filter((c) => !seen.has(c.folderKey) && !!seen.add(c.folderKey));
}

// ------------------------------------------------------------------- C7

/**
 * C7: files that are neither an attachment's file nor a copy of one in one
 * of its item's collection folders. Copies are "expected" whatever their
 * content; differing ones are reported by C4. Trashed items count here too:
 * their files are C14's business.
 */
async function checkOrphans(s: Snapshot, hasher: Hasher): Promise<Issue[]> {
  const known = new Set<string>();
  const attachmentFiles: DiskFile[] = [];
  for (const e of s.entries) {
    const cols = collectionsOf(s, e);
    for (const a of e.attachments) {
      if (a.linkMode !== "linked" || a.rel === null) {
        continue;
      }
      known.add(pathKey(a.rel));
      const file = s.files.get(pathKey(a.rel));
      if (file) {
        attachmentFiles.push(file);
      }
      for (const c of cols) {
        known.add(pathKey(joinRel(c.folder, baseOf(a.rel))));
      }
    }
  }

  const bySize = new Map<number, DiskFile[]>();
  for (const f of attachmentFiles) {
    bySize.set(f.size, [...(bySize.get(f.size) ?? []), f]);
  }

  const issues: Issue[] = [];
  for (const [key, file] of s.files) {
    if (known.has(key)) {
      continue;
    }
    let original: DiskFile | undefined;
    for (const candidate of bySize.get(file.size) ?? []) {
      if (await hasher.same(candidate, file)) {
        original = candidate;
        break;
      }
    }
    issues.push(
      original
        ? { check: "C7", kind: "orphan-copy", severity: "problem", path: file.rel, related: [original.rel] }
        : { check: "C7", kind: "orphan-unique", severity: "problem", path: file.rel },
    );
  }
  return issues;
}

// ------------------------------------------------------------- C8, C9

/** C8: folders that are neither a collection folder nor above one; topmost only. */
function checkStrayFolders(s: Snapshot): Issue[] {
  const wanted = new Set<string>();
  for (const c of s.collections.values()) {
    const parts = c.folder.split("/");
    for (let i = 1; i <= parts.length; i++) {
      wanted.add(pathKey(parts.slice(0, i).join("/")));
    }
  }
  const stray = [...s.folders].filter(([key]) => !wanted.has(key));
  const strayKeys = new Set(stray.map(([key]) => key));
  const fileKeys = [...s.files.keys()];
  return stray
    .filter(([, rel]) => !strayKeys.has(pathKey(dirOf(rel))))
    .map(([key, rel]) => ({
      check: "C8",
      kind: "stray-folder",
      severity: "problem",
      path: rel,
      count: fileKeys.filter((k) => k.startsWith(`${key}/`)).length,
    }));
}

/** C9: leaf collections without active items; collections without a folder. */
function checkCollectionFolders(s: Snapshot): Issue[] {
  const used = new Set<number>();
  for (const e of activeEntries(s)) {
    e.collectionIDs.forEach((id) => used.add(id));
  }
  const issues: Issue[] = [];
  for (const c of s.collections.values()) {
    if (!c.childIDs.length && !used.has(c.id)) {
      issues.push({ check: "C9", kind: "empty", severity: "notice", ...collectionFields(c) });
    }
    if (!s.folders.has(c.folderKey)) {
      issues.push({ check: "C9", kind: "no-folder", severity: "notice", ...collectionFields(c), path: c.folder });
    }
  }
  return issues;
}

// ------------------------------------------------------------ C10, C11

export function normalizeDOI(doi: string): string {
  return doi
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/, "");
}

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** C10: active regular items sharing a DOI or a normalized title (webpages excluded from titles). */
function checkDuplicates(s: Pick<Snapshot, "entries">): Issue[] {
  const regular = activeEntries(s).filter((e) => !e.standalone);
  const issues: Issue[] = [];
  const doiGroups = groupBy(regular, (e) => normalizeDOI(e.doi));
  const seen = new Set(doiGroups.map((g) => groupID(g)));
  for (const group of doiGroups) {
    issues.push(duplicateIssue("same-doi", group));
  }
  const titled = regular.filter((e) => e.itemType !== "webpage");
  for (const group of groupBy(titled, (e) => normalizeTitle(e.title))) {
    if (!seen.has(groupID(group))) {
      issues.push(duplicateIssue("same-title", group));
    }
  }
  return issues;
}

function groupBy(entries: EntryInfo[], keyOf: (e: EntryInfo) => string): EntryInfo[][] {
  const groups = new Map<string, EntryInfo[]>();
  for (const e of entries) {
    const key = keyOf(e);
    if (key) {
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

function groupID(group: EntryInfo[]): string {
  return group.map((e) => e.key).sort().join(",");
}

function duplicateIssue(kind: string, group: EntryInfo[]): Issue {
  const [first, ...rest] = [...group].sort((a, b) => a.key.localeCompare(b.key));
  return { check: "C10", kind, severity: "notice", ...itemFields(first), related: rest.map((e) => e.key) };
}

/** C11: webpage items titled "Article title | Site" whose article is in the library. */
function checkWebpageSnapshots(s: Pick<Snapshot, "entries">): Issue[] {
  const active = activeEntries(s);
  const articles = new Map<string, EntryInfo>();
  for (const e of active) {
    if (!e.standalone && e.itemType !== "webpage") {
      articles.set(normalizeTitle(e.title), e);
    }
  }
  const issues: Issue[] = [];
  for (const e of active) {
    if (e.itemType !== "webpage" || !e.title.includes("|")) {
      continue;
    }
    const article = articles.get(normalizeTitle(e.title.split("|")[0]));
    if (article) {
      issues.push({ check: "C11", kind: "webpage-of-article", severity: "notice", ...itemFields(e), related: [article.key] });
    }
  }
  return issues;
}

// ------------------------------------------------------------------- C12

const DOWNLOAD_SUFFIX = / (?:\(\d+\)|\d)$/;

/**
 * C12: file names with a duplicate-download suffix (" 2", " (1)"), or not
 * following Zotero's rename template. A " - anything" tail after the template
 * name is accepted (e.g. "- arxiv"); case and diacritics are ignored.
 */
function checkFileNames(s: Snapshot): Issue[] {
  const issues: Issue[] = [];
  for (const e of activeEntries(s)) {
    for (const a of linked(e)) {
      if (!a.abs) {
        continue;
      }
      const stem = (a.rel ?? PathUtils.filename(a.abs)).replace(/^.*\//, "").replace(/\.[^.]*$/, "");
      const base = { ...itemFields(e), attachmentKey: a.key, path: a.rel ?? a.abs };
      if (DOWNLOAD_SUFFIX.test(stem)) {
        issues.push({ check: "C12", kind: "download-suffix", severity: "notice", ...base });
        continue;
      }
      if (e.standalone) {
        continue;
      }
      const expected = templateBaseName(e.item, a.title);
      const got = foldName(stem);
      const want = foldName(expected);
      if (got !== want && !got.startsWith(`${want} - `)) {
        issues.push({ check: "C12", kind: "name-template", severity: "notice", ...base, related: [expected] });
      }
    }
  }
  return issues;
}

/**
 * C14 for the folders of trashed collections (§F5.3): each must belong to a
 * collection in Zotero's trash.
 */
function checkCollectionTrash(files: DiskFile[]): Issue[] {
  const counts = new Map<string, number>();
  const prefix = `${PLUGIN_TRASH}/${COLLECTIONS_BUCKET}/`;
  for (const f of files) {
    const key = f.rel.startsWith(prefix) ? f.rel.slice(prefix.length).split("/")[0] : "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const issues: Issue[] = [];
  for (const [key, count] of counts) {
    const collection = key ? Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key) : false;
    if (!collection || !collection.deleted) {
      issues.push({
        check: "C14",
        kind: "trash-without-collection",
        severity: "problem",
        path: joinRel(PLUGIN_TRASH, COLLECTIONS_BUCKET, key),
        count,
      });
    }
  }
  return issues;
}

function foldName(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

// ------------------------------------------------------------------- C14

/**
 * C14: plugin trash and Zotero's trash disagree — a trash folder whose key is
 * not a trashed item or attachment, or a trashed item whose files still sit
 * in collection folders.
 */
function checkTrash(s: Snapshot): Issue[] {
  const issues: Issue[] = [];
  const trashedKeys = new Set<string>();
  for (const e of s.entries) {
    if (e.deleted) {
      trashedKeys.add(e.key);
    }
    const cols = collectionsOf(s, e);
    for (const a of e.attachments) {
      if (!a.deleted) {
        continue;
      }
      trashedKeys.add(a.key);
      if (a.linkMode !== "linked" || a.rel === null) {
        continue;
      }
      const name = baseOf(a.rel);
      const paths = new Map<string, string>([[pathKey(a.rel), a.rel]]);
      for (const c of cols) {
        const rel = joinRel(c.folder, name);
        paths.set(pathKey(rel), rel);
      }
      for (const [key, rel] of paths) {
        if (s.files.has(key)) {
          issues.push({
            check: "C14",
            kind: "trashed-file-outside-trash",
            severity: "problem",
            ...itemFields(e),
            attachmentKey: a.key,
            path: rel,
          });
        }
      }
    }
  }
  for (const [name, files] of s.trash) {
    if (SET_ASIDE_BUCKETS.includes(name)) {
      continue;
    }
    if (name === COLLECTIONS_BUCKET) {
      issues.push(...checkCollectionTrash(files));
      continue;
    }
    if (!name || !trashedKeys.has(name)) {
      issues.push({
        check: "C14",
        kind: "trash-without-item",
        severity: "problem",
        path: joinRel(PLUGIN_TRASH, name),
        count: files.length,
      });
    }
  }
  return issues;
}
