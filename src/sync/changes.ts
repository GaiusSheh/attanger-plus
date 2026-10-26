import { baseOf, collectionFolder, dirOf, joinRel, pathKey, relativeTo, toAbsolute } from "../check/paths";
import { collectionNames } from "../utils/zotero";
import { REPLACED_DIR } from "./guard";
import type { Reconciled } from "./reconcile";
import type { ImportOp, PurgeReplacedOp, ReplaceOp } from "./types";

/*
 * Changes made in the file manager (requirements §F3.6–F3.8). Reconciling
 * without an intent already does what loses nothing (pointing at a copy that
 * is still there, F3.7) and notes the rest; those notes become findings that
 * the user decides on (Phase 2 plan, Q3: one summary window).
 */

export interface CopyInfo {
  rel: string;
  collectionPath: string;
  size: number;
  /** Last modified, ms since the epoch. */
  mtime: number;
}

interface FindingBase {
  itemKey: string;
  itemTitle: string;
  attachmentKey: string;
  /** The user chose to ignore it: still detected and listed, but no automatic window. */
  ignored: boolean;
}

/** Identifies a finding across runs, for "ignore". */
export function findingID(f: Finding): string {
  return f.kind === "copy-missing" ? `${f.kind}:${f.attachmentKey}:${f.collectionID}` : `${f.kind}:${f.attachmentKey}`;
}

/** F3.7: one collection folder lacks its copy. */
export interface CopyMissing extends FindingBase {
  kind: "copy-missing";
  collectionID: number;
  collectionPath: string;
  path: string;
  /** The copy a restore would copy from: the one Zotero points at. */
  source: string;
}

/** F3.6: the copies of one attachment do not all have the same content. */
export interface CopiesDiffer extends FindingBase {
  kind: "copies-differ";
  copies: CopyInfo[];
}

/** F3.8: no copy is left anywhere. */
export interface AllMissing extends FindingBase {
  kind: "all-missing";
  path: string;
}

export type Finding = CopyMissing | CopiesDiffer | AllMissing;

export async function findingsOf(root: string, reconciled: Reconciled[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const r of reconciled) {
    const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, r.itemKey);
    if (!item) {
      continue;
    }
    const differing = new Set<string>();
    for (const note of r.notes) {
      if (!note.attachmentKey) {
        continue;
      }
      const base: FindingBase = {
        itemKey: r.itemKey,
        itemTitle: item.getDisplayTitle(),
        attachmentKey: note.attachmentKey,
        ignored: false,
      };
      if (note.kind === "copy-missing" && note.path) {
        const folderKey = pathKey(dirOf(note.path));
        const collection = collectionsOf(item).find((c) => pathKey(folderOf(c)) === folderKey);
        // Reconciling already pointed Zotero at a surviving copy if its own was gone.
        const source = pointedRel(root, note.attachmentKey);
        if (collection && source) {
          findings.push({
            kind: "copy-missing",
            ...base,
            collectionID: collection.id,
            collectionPath: collectionNames(collection).join("/"),
            path: note.path,
            source,
          });
        }
      } else if (note.kind === "all-missing") {
        findings.push({ kind: "all-missing", ...base, path: note.path ?? "" });
      } else if (note.kind === "copy-differs" && !differing.has(note.attachmentKey)) {
        differing.add(note.attachmentKey);
        const copies = await copiesOf(root, item, note.attachmentKey);
        if (copies.length >= 2) {
          findings.push({ kind: "copies-differ", ...base, copies });
        }
      }
    }
  }
  return findings;
}

/** The path Zotero stores for the attachment, relative to the root; null when outside it or unknown. */
function pointedRel(root: string, attachmentKey: string): string | null {
  const attachment = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, attachmentKey);
  const pointed = attachment ? attachment.getFilePath() : false;
  return pointed ? relativeTo(root, pointed) : null;
}

/** Every existing copy of an attachment in its item's collection folders. */
async function copiesOf(root: string, item: Zotero.Item, attachmentKey: string): Promise<CopyInfo[]> {
  const rel = pointedRel(root, attachmentKey);
  if (rel === null) {
    return [];
  }
  const name = baseOf(rel);
  const copies: CopyInfo[] = [];
  const seen = new Set<string>();
  for (const collection of collectionsOf(item)) {
    const folder = folderOf(collection);
    if (seen.has(pathKey(folder))) {
      continue;
    }
    seen.add(pathKey(folder));
    const copy = joinRel(folder, name);
    try {
      const info = await IOUtils.stat(toAbsolute(root, copy));
      if (info.type === "regular") {
        copies.push({
          rel: copy,
          collectionPath: collectionNames(collection).join("/"),
          size: info.size ?? 0,
          mtime: info.lastModified ?? 0,
        });
      }
    } catch {
      // Missing copies are F3.7's business.
    }
  }
  return copies;
}

function collectionsOf(item: Zotero.Item): Zotero.Collection[] {
  return item
    .getCollections()
    .map((id) => Zotero.Collections.get(id))
    .filter((c): c is Zotero.Collection => !!c);
}

function folderOf(collection: Zotero.Collection): string {
  return collectionFolder(collectionNames(collection));
}

/** Replace each of `targets` with `source`, the old versions kept under one dated folder (§F3.6). */
export function replaceOps(f: CopiesDiffer, source: string, targets: string[], now = new Date()): ReplaceOp[] {
  const stamp = replacedStamp(now);
  return targets
    .filter((t) => pathKey(t) !== pathKey(source))
    .map((to) => ({
      op: "replace",
      itemKey: f.itemKey,
      attachmentKey: f.attachmentKey,
      from: source,
      to,
      backup: `${REPLACED_DIR}/${stamp}/${to}`,
    }));
}

/**
 * F3.8 "relocate": copy a file the user picked (anywhere) to where Zotero
 * expects the attachment; the picked file stays where it is.
 */
export function importOp(f: AllMissing, source: string): ImportOp {
  return { op: "import", itemKey: f.itemKey, attachmentKey: f.attachmentKey, from: source, to: f.path };
}

/** Folder name for one batch of replaced versions: "2026-10-26T15-50-00-123" (UTC). */
export function replacedStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

export function stampDate(name: string): Date | null {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})$/);
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null;
}

/**
 * Dated folders of replaced versions older than Zotero's own trash period
 * (`trashAutoEmptyDays`; 0 keeps them). Folders with other names are left
 * alone.
 */
export async function purgeOps(root: string, now = new Date()): Promise<PurgeReplacedOp[]> {
  const days = Number(Zotero.Prefs.get("trashAutoEmptyDays") ?? 30);
  const dir = toAbsolute(root, REPLACED_DIR);
  if (!(days > 0) || !(await IOUtils.exists(dir))) {
    return [];
  }
  const ops: PurgeReplacedOp[] = [];
  for (const child of await IOUtils.getChildren(dir)) {
    const name = PathUtils.filename(child);
    const date = stampDate(name);
    if (date && now.getTime() - date.getTime() > days * 86_400_000) {
      ops.push({ op: "purge-replaced", path: `${REPLACED_DIR}/${name}` });
    }
  }
  return ops;
}
