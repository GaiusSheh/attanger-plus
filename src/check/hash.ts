import type { DiskFile } from "./snapshot";

/** Survives between check runs; an entry is reused only if size and mtime still match. */
const cache = new Map<string, { size: number; mtime: number; md5: string }>();

/** MD5 of files, computed lazily via Zotero's own streaming md5Async. */
export class Hasher {
  /** Files actually read in this run (cache misses). */
  computed = 0;

  async md5(file: DiskFile): Promise<string> {
    const hit = cache.get(file.abs);
    if (hit && hit.size === file.size && hit.mtime === file.mtime) {
      return hit.md5;
    }
    const internal = Zotero.Utilities.Internal as unknown as {
      md5Async(path: string): Promise<string | false>;
    };
    const md5 = await internal.md5Async(file.abs);
    if (!md5) {
      throw new Error(`File disappeared during the check: ${file.abs}`);
    }
    this.computed++;
    cache.set(file.abs, { size: file.size, mtime: file.mtime, md5 });
    return md5;
  }

  async same(a: DiskFile, b: DiskFile): Promise<boolean> {
    if (a.size !== b.size) {
      return false;
    }
    return (await this.md5(a)) === (await this.md5(b));
  }
}
