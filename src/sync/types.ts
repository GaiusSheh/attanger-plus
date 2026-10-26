/*
 * Write operations on the copies in the collection folders (requirements §F3,
 * §F8). Paths are relative to the files root, "/"-separated, as in src/check.
 */

/** Create a copy of `from` at `to`. */
export interface CopyOp {
  op: "copy";
  itemKey: string;
  attachmentKey: string;
  from: string;
  to: string;
}

/** Delete a copy; `keep` is a byte-identical copy that stays. */
export interface DeleteOp {
  op: "delete";
  itemKey: string;
  attachmentKey: string;
  path: string;
  keep: string;
}

/** Rename (or move) a copy that no attachment points at. */
export interface RenameOp {
  op: "rename";
  itemKey: string;
  attachmentKey: string;
  from: string;
  to: string;
}

/** Point the attachment at another copy of its file. */
export interface RelinkOp {
  op: "relink";
  itemKey: string;
  attachmentKey: string;
  to: string;
}

export type Operation = CopyOp | DeleteOp | RenameOp | RelinkOp;

/**
 * - done: carried out and verified
 * - unchanged: the target state was already there (e.g. an identical copy)
 * - dry-run: dry-run mode, nothing done
 * - skipped: a precondition did not hold; nothing done
 * - failed: started but went wrong; see `reason`
 */
export type OpStatus = "done" | "unchanged" | "dry-run" | "skipped" | "failed";

export interface OpResult {
  operation: Operation;
  status: OpStatus;
  /** Why it was skipped or failed, e.g. "target-exists-differs". */
  reason?: string;
}

/**
 * What the user did in Zotero. A missing copy may have been deleted in the
 * file manager, where the plugin only reports (requirements §3.2), so copies
 * are only made, and files only deleted, on such an intent.
 */
export interface Intent {
  /** Collections the item was just added to, by ID (F3.1): copies go there. */
  addedTo?: number[];
  /** Collections the item was just removed from, by ID (F3.2): copies there go. */
  removedFrom?: number[];
  /** Attachments just added (F3.4) or to restore (F3.7, F2), by key: all missing copies are made. */
  fill?: string[];
}

/** Something the plan saw but deliberately leaves alone. */
export interface PlanNote {
  itemKey: string;
  attachmentKey?: string;
  kind:
    | "no-collection"
    | "outside-root"
    | "all-missing"
    | "misplaced"
    | "copy-missing"
    | "copy-differs"
    | "removed-copy-differs";
  path?: string;
}

export interface Plan {
  operations: Operation[];
  notes: PlanNote[];
}
