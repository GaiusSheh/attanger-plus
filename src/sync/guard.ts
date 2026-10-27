import { pathKey, relativeTo, toAbsolute } from "../check/paths";
import { COLLECTIONS_BUCKET, ORPHANS_BUCKET, PLUGIN_TRASH, REPLACED_BUCKET, SET_ASIDE_BUCKETS } from "../check/snapshot";
import { testDataDir } from "../utils/testDataDir";

/** A precondition did not hold: the operation is skipped, nothing is done. */
export class Skip extends Error {
  constructor(readonly reason: string, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

/** Where replaced old versions go (§F3.6, §F4), relative to the files root. */
export const REPLACED_DIR = `${PLUGIN_TRASH}/${REPLACED_BUCKET}`;

/** Where stray files are set aside on the user's request (§F1.3), relative to the files root. */
export const ORPHANS_DIR = `${PLUGIN_TRASH}/${ORPHANS_BUCKET}`;

/**
 * Absolute path of `rel`, which must be a plain relative path strictly inside
 * the files root and outside the plugin trash (only its replaced-versions
 * area is ever written, through resolveReplacedPath()).
 */
export function resolveInRoot(root: string, rel: string): string {
  const parts = plainParts(rel);
  if (pathKey(parts[0]) === pathKey(PLUGIN_TRASH)) {
    throw new Skip("in-plugin-trash", rel);
  }
  return absoluteInRoot(root, rel);
}

/** Zotero item and collection keys: 8 characters from Zotero's key alphabet. */
const ITEM_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

/** Plugin trash path of an item's or attachment's files (§F4): `.attanger-plus-trash/<key>/…`. */
export function trashPath(key: string, rel: string): string {
  return `${PLUGIN_TRASH}/${key}/${rel}`;
}

/**
 * Absolute path of `rel`, which must lie inside the plugin trash folder of
 * one item key: the folder itself (`depth` "folder") or something in it.
 */
export function resolveTrashPath(root: string, rel: string, depth: "folder" | "inside" = "inside"): string {
  const parts = plainParts(rel);
  const ok =
    pathKey(parts[0]) === pathKey(PLUGIN_TRASH) &&
    ITEM_KEY.test(parts[1] ?? "") &&
    (depth === "folder" ? parts.length === 2 : parts.length >= 3);
  if (!ok) {
    throw new Skip("not-in-item-trash", rel);
  }
  return absoluteInRoot(root, rel);
}

/** Plugin trash path of a trashed collection's folder (§F5.3): `.attanger-plus-trash/_collections/<key>/…`. */
export function collectionTrashPath(key: string, rel = ""): string {
  return rel ? `${PLUGIN_TRASH}/${COLLECTIONS_BUCKET}/${key}/${rel}` : `${PLUGIN_TRASH}/${COLLECTIONS_BUCKET}/${key}`;
}

/**
 * Absolute path of `rel`, which must lie inside the plugin trash folder of
 * one collection key: the folder itself (`depth` "folder") or something in it.
 */
export function resolveCollectionTrashPath(root: string, rel: string, depth: "folder" | "inside" = "inside"): string {
  const parts = plainParts(rel);
  const ok =
    pathKey(parts[0]) === pathKey(PLUGIN_TRASH) &&
    parts[1] === COLLECTIONS_BUCKET &&
    ITEM_KEY.test(parts[2] ?? "") &&
    (depth === "folder" ? parts.length === 3 : parts.length >= 4);
  if (!ok) {
    throw new Skip("not-in-collection-trash", rel);
  }
  return absoluteInRoot(root, rel);
}

/**
 * Absolute path of `rel`, which must lie inside one of the plugin trash's
 * areas for files set aside (`_replaced`, `_orphans`): a dated batch folder
 * or something in it.
 */
export function resolveReplacedPath(root: string, rel: string): string {
  const parts = plainParts(rel);
  if (parts.length < 3 || pathKey(parts[0]) !== pathKey(PLUGIN_TRASH) || !SET_ASIDE_BUCKETS.includes(parts[1])) {
    throw new Skip("not-in-replaced-area", rel);
  }
  return absoluteInRoot(root, rel);
}

function plainParts(rel: string): string[] {
  if (!rel || rel.includes("\\") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) {
    throw new Skip("not-a-relative-path", rel);
  }
  const parts = rel.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) {
    throw new Skip("bad-path-segment", rel);
  }
  return parts;
}

function absoluteInRoot(root: string, rel: string): string {
  const abs = toAbsolute(root, rel);
  if (relativeTo(root, abs) === null) {
    throw new Skip("outside-root", rel);
  }
  return abs;
}

/**
 * The files root writes may go to. With a development or test data
 * directory, only the test library's root, even if a copy of the real
 * database is loaded there with the root pointed at the real files
 * (known_pits C8). Decided by data directory rather than build flag: test
 * bundles have no __DEV__, and a release build may run in the dev profile.
 */
export function writableRoot(): string {
  const root = (Zotero.Prefs.get("baseAttachmentPath") as string | undefined) || "";
  if (!root) {
    throw new Error("Zotero's base directory for linked files is not set");
  }
  const test = testDataDir();
  if (test && pathKey(PathUtils.normalize(root)) !== pathKey(PathUtils.normalize(test.root))) {
    throw new Error(`Refusing to write outside the test library: root is ${root}, expected ${test.root}`);
  }
  return root;
}
