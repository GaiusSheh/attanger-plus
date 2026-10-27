import { checkFiles, checkLibrary } from "./checks";
import { Hasher } from "./hash";
import { pathKey } from "./paths";
import { readLibrary, takeSnapshot } from "./snapshot";
import { readIgnoredIssues } from "../sync/state";
import { CHECK_IDS, IGNORABLE_CHECKS, issueID, type CheckId, type CheckReport, type ConfigNotice, type Issue } from "./types";

export type { CheckReport, Issue } from "./types";

/**
 * Compare the library with the files root and report every disagreement.
 * Read-only: nothing in Zotero or on disk is changed.
 */
export async function runCheck(): Promise<CheckReport> {
  const started = new Date();
  const config: ConfigNotice[] = [];
  const root = (Zotero.Prefs.get("baseAttachmentPath") as string | undefined) || null;
  config.push(...attangerNotices(root));

  let issues: Issue[];
  const hasher = new Hasher();
  let stats: CheckReport["stats"];
  if (!root) {
    config.push({ kind: "root-unset", detail: "Zotero's base directory for linked files is not set." });
  } else if (!(await IOUtils.exists(root))) {
    config.push({ kind: "root-missing", detail: root });
  }

  if (config.some((n) => n.kind === "root-unset" || n.kind === "root-missing")) {
    // Without a files root only the library-side checks make sense.
    const libraryOnly = await readLibrary(null);
    issues = checkLibrary(libraryOnly);
    stats = statsOf(libraryOnly.collections.size, libraryOnly.entries, 0, 0, 0);
  } else {
    const snapshot = await takeSnapshot(root!);
    issues = [...checkLibrary(snapshot), ...(await checkFiles(snapshot, hasher))];
    stats = statsOf(
      snapshot.collections.size,
      snapshot.entries,
      snapshot.files.size,
      snapshot.folders.size,
      hasher.computed,
    );
  }

  issues.sort(compareIssues);
  const ignored = await readIgnoredIssues();
  const counts = Object.fromEntries(CHECK_IDS.map((id) => [id, 0])) as Record<CheckId, number>;
  for (const issue of issues) {
    if (IGNORABLE_CHECKS.includes(issue.check) && ignored.has(issueID(issue))) {
      issue.ignored = true;
    } else {
      counts[issue.check]++;
    }
  }
  return {
    root,
    startedAt: started.toISOString(),
    durationMs: Date.now() - started.getTime(),
    config,
    counts,
    issues,
    stats,
  };
}

/** The plugin assumes Attanger in linked mode with "{{collection}}" subfolders (requirements §3). */
export function attangerNotices(root: string | null): ConfigNotice[] {
  const notices: ConfigNotice[] = [];
  const workMode = Zotero.Prefs.get("zoteroattanger.workMode") as string | undefined;
  const subfolder = Zotero.Prefs.get("zoteroattanger.subfolderFormat") as string | undefined;
  const destDir = Zotero.Prefs.get("zoteroattanger.destDir") as string | undefined;
  if (workMode && workMode !== "linked") {
    notices.push({ kind: "attanger-not-linked", detail: workMode });
  }
  if (subfolder !== undefined && subfolder !== "{{collection}}") {
    notices.push({ kind: "attanger-subfolder-format", detail: subfolder });
  }
  if (destDir && root && pathKey(PathUtils.normalize(destDir)) !== pathKey(PathUtils.normalize(root))) {
    notices.push({ kind: "attanger-dest-differs", detail: destDir });
  }
  return notices;
}

function statsOf(
  collections: number,
  entries: { deleted: boolean; attachments: { linkMode: string; deleted: boolean }[] }[],
  files: number,
  folders: number,
  hashed: number,
): CheckReport["stats"] {
  const active = entries.filter((e) => !e.deleted);
  return {
    collections,
    items: active.length,
    linkedAttachments: active.flatMap((e) => e.attachments).filter((a) => a.linkMode === "linked" && !a.deleted)
      .length,
    files,
    folders,
    hashed,
  };
}

function compareIssues(a: Issue, b: Issue): number {
  return (
    CHECK_IDS.indexOf(a.check) - CHECK_IDS.indexOf(b.check) ||
    a.kind.localeCompare(b.kind) ||
    (a.path ?? a.collectionPath ?? a.itemTitle ?? "").localeCompare(b.path ?? b.collectionPath ?? b.itemTitle ?? "")
  );
}
