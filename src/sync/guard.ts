import { pathKey, relativeTo, toAbsolute } from "../check/paths";
import { PLUGIN_TRASH, REPLACED_BUCKET } from "../check/snapshot";
import { testDataDir } from "../utils/testDataDir";

/** A precondition did not hold: the operation is skipped, nothing is done. */
export class Skip extends Error {
  constructor(readonly reason: string, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

/** Where replaced old versions go (§F3.6, §F4), relative to the files root. */
export const REPLACED_DIR = `${PLUGIN_TRASH}/${REPLACED_BUCKET}`;

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

/** Absolute path of `rel`, which must lie inside the plugin trash's replaced-versions area. */
export function resolveReplacedPath(root: string, rel: string): string {
  const parts = plainParts(rel);
  if (parts.length < 3 || pathKey(parts[0]) !== pathKey(PLUGIN_TRASH) || parts[1] !== REPLACED_BUCKET) {
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
