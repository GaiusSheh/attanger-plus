import type { OpResult } from "./types";

/*
 * Operation log (requirements §F8): one JSON object per line, one file per
 * month, in the Zotero data directory rather than the files root so that
 * neither the check nor a file-sync service sees it.
 */

export function pluginDataDir(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, "attanger-plus");
}

export function logFileFor(date: Date): string {
  return PathUtils.join(pluginDataDir(), `operations-${date.toISOString().slice(0, 7)}.jsonl`);
}

export interface LogRecord {
  time: string;
  dryRun: boolean;
  status: OpResult["status"];
  reason?: string;
  op: string;
  itemKey?: string;
  attachmentKey?: string;
  from?: string;
  to?: string;
  path?: string;
  keep?: string;
}

// Appends are chained so that lines never interleave.
let pending: Promise<void> = Promise.resolve();

export function appendLog(result: OpResult, dryRun: boolean): Promise<void> {
  const now = new Date();
  const record: LogRecord = {
    time: now.toISOString(),
    dryRun,
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    ...result.operation,
  };
  const line = `${JSON.stringify(record)}\n`;
  pending = pending
    .catch(() => {})
    .then(async () => {
      await IOUtils.makeDirectory(pluginDataDir(), { createAncestors: true, ignoreExisting: true });
      await IOUtils.writeUTF8(logFileFor(now), line, { mode: "appendOrCreate" });
    });
  return pending;
}
