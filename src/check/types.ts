/** Check numbers follow requirements §F1.1. C13 was dropped and stays unused. */
export type CheckId =
  | "C1"
  | "C2"
  | "C3"
  | "C4"
  | "C5"
  | "C6"
  | "C7"
  | "C8"
  | "C9"
  | "C10"
  | "C11"
  | "C12"
  | "C14";

export const CHECK_IDS: CheckId[] = [
  "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11", "C12", "C14",
];

/** "problem": the folders and the library disagree; "notice": worth a look. */
export type Severity = "problem" | "notice";

export interface Issue {
  check: CheckId;
  /** Sub-type within the check, e.g. "copy-missing" vs "copy-differs" for C4. */
  kind: string;
  severity: Severity;
  itemKey?: string;
  itemTitle?: string;
  attachmentKey?: string;
  collectionKey?: string;
  /** Collection path such as "Physics/Optics". */
  collectionPath?: string;
  /** File or folder; relative to the files root ("/"-separated) when inside it. */
  path?: string;
  /** Other files, items or names the issue refers to (see each check). */
  related?: string[];
  /** Number of files, for folder issues. */
  count?: number;
  /** The user chose to ignore it (only checks in IGNORABLE_CHECKS): not counted, listed apart. */
  ignored?: boolean;
}

/** Notices the user may mark as fine for good (§F1.1): file names kept on purpose. */
export const IGNORABLE_CHECKS: CheckId[] = ["C12"];

/** Identifies an issue across runs, for ignoring it. */
export function issueID(issue: Issue): string {
  return `${issue.check}:${issue.kind}:${issue.attachmentKey ?? issue.path ?? ""}`;
}

/** Settings that make the check unreliable or impossible. */
export interface ConfigNotice {
  kind:
    | "root-unset"
    | "root-missing"
    | "attanger-dest-differs"
    | "attanger-not-linked"
    | "attanger-subfolder-format";
  detail: string;
}

export interface CheckReport {
  /** Files root (Zotero's base attachment path). */
  root: string | null;
  startedAt: string;
  durationMs: number;
  config: ConfigNotice[];
  counts: Record<CheckId, number>;
  issues: Issue[];
  stats: {
    collections: number;
    items: number;
    linkedAttachments: number;
    files: number;
    folders: number;
    hashed: number;
  };
}
