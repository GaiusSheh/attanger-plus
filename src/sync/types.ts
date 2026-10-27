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

/** Remove a temporary copy left behind by an interrupted copy (TEMP_SUFFIX). */
export interface DiscardTempOp {
  op: "discard-temp";
  path: string;
}

/**
 * Replace the copy `to` with the content of `from`, on the user's explicit
 * choice (§F3.6); the old `to` is first moved to `backup`, inside the plugin
 * trash's replaced-versions area.
 */
export interface ReplaceOp {
  op: "replace";
  itemKey: string;
  attachmentKey: string;
  from: string;
  to: string;
  backup: string;
}

/** Delete one dated folder of replaced versions once it is old enough (§F4). */
export interface PurgeReplacedOp {
  op: "purge-replaced";
  path: string;
}

/**
 * Copy a file from anywhere (absolute `from`, which stays) to `to` inside the
 * root, on the user's explicit choice (§F3.8 relocate).
 */
export interface ImportOp {
  op: "import";
  itemKey: string;
  attachmentKey: string;
  from: string;
  to: string;
}

/**
 * Move a file of a trashed item or attachment into the plugin trash (§F4):
 * `path` in the root to `to` = `.attanger-plus-trash/<key>/<path>`.
 */
export interface TrashOp {
  op: "trash";
  itemKey: string;
  attachmentKey: string;
  path: string;
  to: string;
}

/** Move a file of a restored item or attachment back out of the plugin trash (§F4). */
export interface UntrashOp {
  op: "untrash";
  itemKey: string;
  attachmentKey: string;
  from: string;
  to: string;
}

/**
 * Delete a plugin trash folder `.attanger-plus-trash/<key>` (§F4): with
 * everything in it once Zotero erased the item, or only if no file is left
 * in it after a restore.
 */
export interface PurgeTrashOp {
  op: "purge-trash";
  itemKey: string;
  path: string;
  onlyIfEmpty: boolean;
}

/**
 * Move a collection's folder with everything in it to where the collection
 * now is (§F5.1); the target must not exist (a case-only change excepted).
 */
export interface MoveFolderOp {
  op: "move-folder";
  collectionKey: string;
  from: string;
  to: string;
}

/** Move one file into a collection's new folder that already exists (§F5.1); never over a different file. */
export interface MoveFileOp {
  op: "move-file";
  collectionKey: string;
  from: string;
  to: string;
}

/**
 * Change the path Zotero stores for an attachment whose file is missing, to
 * where the file belongs now that its collection's folder moved (§F5.1).
 * No file is touched.
 */
export interface RepointOp {
  op: "repoint";
  itemKey: string;
  attachmentKey: string;
  to: string;
}

/** Remove a collection's old folder once nothing but empty folders is left in it (§F5.1). */
export interface RemoveEmptyFolderOp {
  op: "remove-empty-folder";
  collectionKey: string;
  path: string;
}

export type Operation =
  | CopyOp
  | DeleteOp
  | RenameOp
  | RelinkOp
  | DiscardTempOp
  | ReplaceOp
  | PurgeReplacedOp
  | ImportOp
  | TrashOp
  | UntrashOp
  | PurgeTrashOp
  | MoveFolderOp
  | MoveFileOp
  | RepointOp
  | RemoveEmptyFolderOp;

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
  /** The item, or some of its attachments, just went to Zotero's trash (§F4): their files go to the plugin trash. */
  trash?: boolean;
  /**
   * With `trash`: collections the item was just removed from, whose folders
   * still hold its copies (§F3.3 "keep the item, delete the files").
   */
  formerCollections?: number[];
  /** The item, or some of its attachments, just came back from Zotero's trash (§F4): their files come back. */
  restore?: boolean;
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
    | "removed-copy-differs"
    /** A file of a trashed attachment that a live item uses too (known_pits A8): left in place. */
    | "in-use"
    /** A file in the plugin trash that has no place among the restored item's collection folders. */
    | "left-in-trash"
    /** A renamed or moved collection's old folder still belongs to another collection: left alone. */
    | "folder-shared";
  path?: string;
}

export interface Plan {
  operations: Operation[];
  notes: PlanNote[];
}
