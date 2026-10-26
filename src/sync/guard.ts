import { pathKey, relativeTo, toAbsolute } from "../check/paths";
import { PLUGIN_TRASH } from "../check/snapshot";
import { testDataDir } from "../utils/testDataDir";

/** A precondition did not hold: the operation is skipped, nothing is done. */
export class Skip extends Error {
  constructor(readonly reason: string, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

/**
 * Absolute path of `rel`, which must be a plain relative path strictly inside
 * the files root and outside the plugin trash (Phase 2 never touches it).
 */
export function resolveInRoot(root: string, rel: string): string {
  if (!rel || rel.includes("\\") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) {
    throw new Skip("not-a-relative-path", rel);
  }
  const parts = rel.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) {
    throw new Skip("bad-path-segment", rel);
  }
  if (pathKey(parts[0]) === pathKey(PLUGIN_TRASH)) {
    throw new Skip("in-plugin-trash", rel);
  }
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
