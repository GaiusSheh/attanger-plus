import { log } from "../utils/log";
import { pluginDataDir } from "./log";

/*
 * What the plugin last knew about each attachment's file. Notifier events do
 * not carry an attachment's previous path (known_pits A7), so renames (F3.5)
 * and "which copy was edited" (F3.6) are judged against this record.
 * Losing it is harmless: it is rebuilt from the current state, and nothing is
 * ever deleted on the strength of a rebuilt record.
 */

export interface AttachmentRecord {
  /** File name of the copies. */
  name: string;
  /** Folder of the copy Zotero points at, relative to the files root. */
  folder: string;
  size: number;
  mtime: number;
  md5: string;
}

interface StateFile {
  version: 1;
  attachments: Record<string, AttachmentRecord>;
  /**
   * Findings the user chose to ignore (§F3.6–F3.8): no automatic window for
   * them; they are still detected and listed on request. Absent in files
   * written before 2-5.
   */
  ignored?: string[];
}

export function stateFile(): string {
  return PathUtils.join(pluginDataDir(), "state.json");
}

export class AttachmentState {
  private constructor(private readonly data: StateFile) {}

  /** The saved record; an unreadable file is set aside and an empty record started. */
  static async load(): Promise<AttachmentState> {
    const path = stateFile();
    if (!(await IOUtils.exists(path))) {
      return new AttachmentState(empty());
    }
    try {
      const data = (await IOUtils.readJSON(path)) as StateFile;
      if (data?.version !== 1 || typeof data.attachments !== "object" || data.attachments === null) {
        throw new Error(`unexpected content (version ${String(data?.version)})`);
      }
      return new AttachmentState(data);
    } catch (e) {
      const aside = PathUtils.join(pluginDataDir(), `state.broken-${Date.now()}.json`);
      await IOUtils.move(path, aside);
      log(`attachment state unreadable (${String(e)}); moved to ${aside}, starting empty`);
      return new AttachmentState(empty());
    }
  }

  get(attachmentKey: string): AttachmentRecord | undefined {
    return this.data.attachments[attachmentKey];
  }

  isIgnored(findingID: string): boolean {
    return (this.data.ignored ?? []).includes(findingID);
  }

  ignoredIDs(): string[] {
    return [...(this.data.ignored ?? [])];
  }

  setIgnored(findingID: string, ignored: boolean): void {
    const rest = (this.data.ignored ?? []).filter((id) => id !== findingID);
    this.data.ignored = ignored ? [...rest, findingID] : rest;
  }

  set(attachmentKey: string, record: AttachmentRecord): void {
    this.data.attachments[attachmentKey] = record;
  }

  delete(attachmentKey: string): void {
    delete this.data.attachments[attachmentKey];
  }

  keys(): string[] {
    return Object.keys(this.data.attachments);
  }

  /** Written to a temporary file first, so a crash never leaves half a file. */
  async save(): Promise<void> {
    await IOUtils.makeDirectory(pluginDataDir(), { createAncestors: true, ignoreExisting: true });
    const path = stateFile();
    await IOUtils.writeJSON(path, this.data, { tmpPath: `${path}.tmp` });
  }
}

function empty(): StateFile {
  return { version: 1, attachments: {} };
}
