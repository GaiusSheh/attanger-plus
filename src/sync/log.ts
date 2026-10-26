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
      await appendWithRetry(logFileFor(now), line);
    });
  return pending;
}

/**
 * A file-sync service can hold the log open for a moment
 * (NS_ERROR_FILE_IS_LOCKED, seen with the test data directory in OneDrive),
 * so retry briefly. If it still fails, the operation has already happened:
 * report the lost line rather than fail the operation.
 */
async function appendWithRetry(path: string, line: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await IOUtils.writeUTF8(path, line, { mode: "appendOrCreate" });
      return;
    } catch (e) {
      if (attempt >= 5) {
        Zotero.logError(new Error(`Attanger Plus could not write its operation log (${String(e)}); lost line: ${line}`));
        return;
      }
      await Zotero.Promise.delay(200 * attempt);
    }
  }
}
