/*
 * Paths inside the files root are handled as "/"-separated relative paths.
 * Comparisons go through pathKey(), which folds case where the file system
 * usually does (Windows, macOS).
 */

export function pathKey(rel: string): string {
  const normalized = rel.normalize("NFC");
  return Zotero.isWin || Zotero.isMac ? normalized.toLowerCase() : normalized;
}

/** `abs` relative to `root`, or null when it is not strictly inside it. */
export function relativeTo(root: string, abs: string): string | null {
  const rootParts = PathUtils.split(PathUtils.normalize(root));
  const parts = PathUtils.split(PathUtils.normalize(abs));
  if (parts.length <= rootParts.length) {
    return null;
  }
  for (let i = 0; i < rootParts.length; i++) {
    if (pathKey(rootParts[i]) !== pathKey(parts[i])) {
      return null;
    }
  }
  return parts.slice(rootParts.length).join("/");
}

export function toAbsolute(root: string, rel: string): string {
  return rel ? PathUtils.join(root, ...rel.split("/")) : root;
}

export function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

export function baseOf(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

export function joinRel(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}

/**
 * Folder of a collection, given the names from the top-level collection down.
 * Attanger joins the raw names, and a "/" or "\" inside a name ends up as a
 * further folder level, so split on both.
 */
export function collectionFolder(names: string[]): string {
  return names
    .flatMap((name) => name.split(/[\\/]/))
    .filter(Boolean)
    .join("/");
}
