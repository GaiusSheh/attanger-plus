import { log } from "../utils/log";
import { getPref } from "../utils/prefs";
import { findingID, findingsOf, type Finding } from "./changes";
import { writableRoot } from "./guard";
import { execute } from "./ops";
import {
  purgeErased,
  reconcile,
  reconcileFolders,
  recordCollectionFolders,
  recordSynced,
  scanAtStartup,
  type Reconciled,
  type ScanSummary,
} from "./reconcile";
import { AttachmentState } from "./state";
import type { Intent, Operation, OpResult } from "./types";

/*
 * Zotero's Notifier events only mark items and what the user did to them
 * (an Intent); once the library has been quiet for a moment, all marked
 * items are reconciled in one go (Phase 2 plan, 2-3). Event order, repeats
 * and the plugin's own relinks therefore do not matter: reconciling an item
 * that is already in its target state does nothing.
 *
 * Attanger handles new attachments about 1–1.5 s after they appear, turning
 * a stored one into a new linked attachment (known_pits A3); items that
 * still have such a fresh stored attachment wait for it, up to a limit.
 *
 * Changes made in the file manager (§F3.6–F3.8) are looked for at the
 * startup scan, when an attachment is opened, and on request (the check
 * report); what needs the user's decision goes to `onFindings`.
 *
 * Items going into Zotero's trash, coming back, or being erased take their
 * files along into, out of, or away with the plugin trash (§F4, trash.ts).
 *
 * Changes that Zotero sync brings in from another device are that device's
 * to carry out; its files arrive through the user's file sync (Phase 3 plan,
 * 3-1). They only bring the attachment records up to date. Sync saves items
 * with `skipRenameFile` in the event data (Zotero's syncLocal.js), which
 * nothing else sets; collection-item events carry no data, but follow the
 * item's own event in the same commit.
 */

/** Quiet time before marked items are reconciled. */
const QUIET_MS = 3_000;
/** Longest wait for Attanger to convert a fresh stored attachment. */
const ATTANGER_MAX_WAIT_MS = 30_000;
/** A stored attachment younger than this may still be converted by Attanger. */
const FRESH_STORED_MS = 60_000;
/** The startup scan waits until Zotero has settled. */
const STARTUP_SCAN_DELAY_MS = 10_000;
/** How long a synced change of an item waits for its collection-item and trash events. */
const SYNCED_MS = 60_000;

const ATTANGER_ID = "zoteroattanger@polygon.org";

interface Marked {
  addedTo: Set<number>;
  removedFrom: Set<number>;
  fill: Set<string>;
  trash: boolean;
  restore: boolean;
  /** When the item was first marked in this round. */
  since: number;
}

/** An item with files the user just removed from its last collection (§F3.3). */
export interface Unfiled {
  itemKey: string;
  itemTitle: string;
  /** The collections it was removed from, by ID. */
  removedFrom: number[];
}

const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

export class SyncQueue {
  private marked = new Map<string, Marked>();
  /** Collections renamed or moved here, by ID, whose folders are to follow (§F5.1). */
  private collections = new Set<number>();
  /** Items sync just changed: item ID -> when; read by their collection-item and trash events. */
  private synced = new Map<number, number>();
  private timer?: number;
  private startupTimer?: number;
  private observerID?: string;
  private paused = 0;
  private stopped = true;
  private state?: AttachmentState;
  /** All reconciling and scanning runs one at a time along this chain. */
  private chain: Promise<void> = Promise.resolve();
  /** Receives file-manager changes that need the user's decision (set by the UI). */
  onFindings?: (findings: Finding[]) => void;
  /** Receives items just removed from their last collection, for the user to decide on (§F3.3; set by the UI). */
  onUnfiled?: (items: Unfiled[]) => void;

  start(): void {
    this.stopped = false;
    this.observerID = Zotero.Notifier.registerObserver(
      { notify: (event: string, type: string, ids: (string | number)[], extraData: Record<string, unknown>) => this.onNotify(event, type, ids, extraData) },
      ["item", "collection-item", "file", "collection"],
      "attanger-plus",
    );
    this.scanLater();
  }

  /**
   * Look for changes made in the file manager to these items (all when
   * omitted); does what loses nothing, returns the rest.
   */
  inspect(itemKeys?: string[]): Promise<Finding[]> {
    return this.enqueue(() => this.inspectNow(itemKeys));
  }

  /** Carry out operations in turn with all other work (e.g. the user's choices in the changes window). */
  run(operations: Operation[]): Promise<OpResult[]> {
    return this.enqueue(() => execute(operations));
  }

  /** Ignore findings (no automatic window), or stop ignoring them. */
  setIgnored(findingIDs: string[], ignored: boolean): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.loadState();
      for (const id of findingIDs) {
        state.setIgnored(id, ignored);
      }
      await state.save();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.observerID) {
      Zotero.Notifier.unregisterObserver(this.observerID);
      this.observerID = undefined;
    }
    this.clearTimers();
    this.marked.clear();
    this.collections.clear();
    await this.chain;
  }

  /** Ignore events and drop marked items until resume(); waits for running work to end. */
  async pause(): Promise<void> {
    this.paused++;
    this.marked.clear();
    this.collections.clear();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.chain;
  }

  resume(): void {
    this.paused = Math.max(0, this.paused - 1);
  }

  /** Reconcile everything marked now, without waiting for quiet or for Attanger (tests, agents). */
  async flush(): Promise<void> {
    // The plugin's own relinks mark items again; a few rounds settle that.
    for (let round = 0; round < 5; round++) {
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      await this.enqueue(() => this.process(true));
      if (!this.marked.size && !this.collections.size) {
        return;
      }
    }
  }

  /** The startup scan (temporary files, attachment state); also callable directly. */
  scan(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) {
        return;
      }
      if (this.paused || syncInProgress()) {
        // Try again later rather than never. During a sync the library is
        // half way between two states, and a synced rename would look like
        // one made here.
        this.scanLater();
        return;
      }
      const summary: ScanSummary = await scanAtStartup(await this.loadState());
      const done = (results: OpResult[]) => results.filter((r) => r.status === "done").length;
      log(
        `sync startup scan: ${done(summary.tempFiles)}/${summary.tempFiles.length} temporary files removed, ` +
          `${done(summary.purged)}/${summary.purged.length} old replaced versions purged, ` +
          `${summary.recorded} attachments recorded, ${summary.forgotten} forgotten`,
      );
      if (getPref("inspectOnStartup") !== false) {
        this.report(await this.inspectNow());
      }
    });
  }

  private async inspectNow(itemKeys?: string[]): Promise<Finding[]> {
    const keys = itemKeys ?? (await allEntryKeys());
    const state = await this.loadState();
    const reconciled = await reconcile(new Map(keys.map((k) => [k, {}])), state);
    const findings = await findingsOf(writableRoot(), reconciled);
    const found = new Set(findings.map(findingID));
    for (const f of findings) {
      f.ignored = state.isIgnored(findingID(f));
    }
    // An ignored finding that is gone (file back, or dealt with) is forgotten.
    const inspected = itemKeys ? attachmentKeysOf(itemKeys) : null;
    let forgot = false;
    for (const id of state.ignoredIDs()) {
      const attachmentKey = id.split(":")[1];
      if (!found.has(id) && (!inspected || inspected.has(attachmentKey))) {
        state.setIgnored(id, false);
        forgot = true;
      }
    }
    if (forgot) {
      await state.save();
    }
    return findings;
  }

  /**
   * Items with files that the user just removed from their last collection
   * (§F3.3): their files stayed where they were, and the user decides.
   */
  private reportUnfiled(done: Reconciled[], intents: Map<string, Intent>): void {
    const unfiled: Unfiled[] = [];
    for (const r of done) {
      const removedFrom = intents.get(r.itemKey)?.removedFrom ?? [];
      const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, r.itemKey);
      if (removedFrom.length && item && !item.deleted && r.notes.some((n) => n.kind === "no-collection")) {
        unfiled.push({ itemKey: r.itemKey, itemTitle: item.getDisplayTitle(), removedFrom });
      }
    }
    if (unfiled.length && !this.stopped) {
      try {
        this.onUnfiled?.(unfiled);
      } catch (e) {
        log(`sync: asking about unfiled items failed: ${String(e)}`);
      }
    }
  }

  /** Automatic windows (startup, opening an attachment) leave out what the user ignored. */
  private report(all: Finding[]): void {
    const findings = all.filter((f) => !f.ignored);
    if (findings.length && !this.stopped) {
      try {
        this.onFindings?.(findings);
      } catch (e) {
        log(`sync: showing findings failed: ${String(e)}`);
      }
    }
  }

  private scanLater(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      // Failures are logged by enqueue().
      this.scan().catch(() => {});
    }, STARTUP_SCAN_DELAY_MS);
  }

  private onNotify(event: string, type: string, ids: (string | number)[], extraData: Record<string, unknown>): void {
    if (this.paused || this.stopped) {
      return;
    }
    try {
      if (type === "collection-item") {
        this.onCollectionItem(event, ids);
      } else if (type === "item") {
        this.onItem(event, ids, extraData);
      } else if (type === "file" && event === "open") {
        this.onOpen(ids);
      } else if (type === "collection") {
        this.onCollection(event, ids, extraData);
      }
      if (this.marked.size || this.collections.size) {
        this.schedule();
      }
    } catch (e) {
      log(`sync: failed to handle ${type} ${event}: ${String(e)}`);
    }
  }

  /** ids are "<collectionID>-<itemID>" (known_pits A7). */
  private onCollectionItem(event: string, ids: (string | number)[]): void {
    if (event !== "add" && event !== "remove") {
      return;
    }
    for (const id of ids) {
      const [collectionID, itemID] = String(id).split("-").map(Number);
      const item = Zotero.Items.get(itemID);
      if (!item || item.libraryID !== Zotero.Libraries.userLibraryID) {
        continue;
      }
      if (this.takeSynced(itemID)) {
        continue;
      }
      const m = this.mark(entryKey(item));
      if (event === "add") {
        m.addedTo.add(collectionID);
        m.removedFrom.delete(collectionID);
      } else {
        m.removedFrom.add(collectionID);
        m.addedTo.delete(collectionID);
      }
    }
  }

  private onItem(event: string, ids: (string | number)[], extraData: Record<string, unknown>): void {
    if (event === "trash") {
      // Into Zotero's trash: the files follow (§F4). Sync's trashing comes
      // after its own marked modify event in the same commit.
      for (const id of ids) {
        const item = Zotero.Items.get(Number(id));
        if (item && item.libraryID === Zotero.Libraries.userLibraryID && !this.takeSynced(item.id)) {
          this.mark(entryKey(item)).trash = true;
        }
      }
      return;
    }
    if (event === "delete") {
      // Erased: its plugin trash folder goes (§F4). Erasing a never-trashed
      // item (e.g. Attanger replacing a stored attachment) leaves no folder.
      const erased: string[] = [];
      for (const id of ids) {
        const data = extraData?.[id] as { key?: string; libraryID?: number; skipDeleteLog?: boolean } | undefined;
        if (!data?.key || data.libraryID !== Zotero.Libraries.userLibraryID) {
          continue;
        }
        this.marked.delete(data.key);
        // Deletions applied by sync carry skipDeleteLog: the other device purged its folder.
        if (!data.skipDeleteLog) {
          erased.push(data.key);
        }
      }
      if (erased.length) {
        this.enqueue(async () => {
          await purgeErased(erased);
        }).catch(() => {});
      }
      return;
    }
    if (event !== "add" && event !== "modify") {
      return;
    }
    const synced: string[] = [];
    for (const id of ids) {
      const item = Zotero.Items.get(Number(id));
      if (!item || item.libraryID !== Zotero.Libraries.userLibraryID) {
        continue;
      }
      const data = extraData?.[id] as { skipRenameFile?: boolean; changed?: { deleted?: boolean } } | undefined;
      if (data?.skipRenameFile) {
        // Its collection-item and trash events follow in the same commit.
        this.synced.set(item.id, Date.now());
        if (item.isAttachment()) {
          synced.push(item.key);
        }
        continue;
      }
      // A change made here; its collection-item and trash events are ours.
      this.synced.delete(item.id);
      // `changed` holds the values from before: out of Zotero's trash (§F4).
      if (data?.changed?.deleted === true && !item.deleted) {
        this.mark(entryKey(item)).restore = true;
      }
      // Regular items join collections through collection-item events.
      if (!item.isAttachment()) {
        continue;
      }
      const m = this.mark(entryKey(item));
      if (event === "add" && item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE) {
        m.fill.add(item.key);
      }
    }
    if (synced.length) {
      this.enqueue(() => this.noteSynced(synced)).catch(() => {});
    }
  }

  /**
   * Whether sync just changed this item. Kept for all of the commit's
   * collection-item and trash events (adds and removes come in separate
   * calls); a change made here clears it, as it comes with an item event
   * of its own first.
   */
  private takeSynced(itemID: number): boolean {
    const now = Date.now();
    for (const [id, at] of this.synced) {
      if (now - at > SYNCED_MS) {
        this.synced.delete(id);
      }
    }
    return this.synced.has(itemID);
  }

  /** Synced attachments: their records follow Zotero, their files are left to the device that changed them. */
  private async noteSynced(attachmentKeys: string[]): Promise<void> {
    const root = writableRoot();
    const state = await this.loadState();
    for (const key of attachmentKeys) {
      recordSynced(root, key, state);
    }
    await state.save();
    log(`sync: ${attachmentKeys.length} attachment(s) changed by Zotero sync; records updated, files left alone`);
  }

  /**
   * Collections (§F5.1). A rename or move made here moves the folder; one
   * sync brought in only updates the recorded folders (the other device
   * moved it). Sync saves with `skipSelect`, but so does undo, hence also
   * the check that a sync is running. New collections are recorded.
   */
  private onCollection(event: string, ids: (string | number)[], extraData: Record<string, unknown>): void {
    if (event === "add") {
      this.recordCollections().catch(() => {});
      return;
    }
    if (event !== "modify") {
      return;
    }
    let synced = false;
    for (const id of ids) {
      const data = extraData?.[id] as { skipSelect?: boolean } | undefined;
      if (data?.skipSelect && syncInProgress()) {
        synced = true;
      } else {
        this.collections.add(Number(id));
      }
    }
    if (synced) {
      this.recordCollections().catch(() => {});
    }
  }

  /** Record where every collection's folder is now (also after building a test library while paused). */
  recordCollections(): Promise<void> {
    return this.enqueue(async () => recordCollectionFolders(await this.loadState()));
  }

  /** An attachment was opened: look at its item now (known_pits A7: `file` `open`). */
  private onOpen(ids: (string | number)[]): void {
    const keys = new Set<string>();
    for (const id of ids) {
      const item = Zotero.Items.get(Number(id));
      if (item && item.libraryID === Zotero.Libraries.userLibraryID) {
        keys.add(entryKey(item));
      }
    }
    if (keys.size) {
      this.enqueue(async () => this.report(await this.inspectNow([...keys]))).catch(() => {});
    }
  }

  private mark(key: string): Marked {
    let m = this.marked.get(key);
    if (!m) {
      m = { addedTo: new Set(), removedFrom: new Set(), fill: new Set(), trash: false, restore: false, since: Date.now() };
      this.marked.set(key, m);
    }
    return m;
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Failures are logged by enqueue().
      this.enqueue(() => this.process(false)).catch(() => {});
    }, QUIET_MS);
  }

  private async process(force: boolean): Promise<void> {
    if (this.stopped || this.paused) {
      return;
    }
    // Folders first, so that the items are reconciled against the new ones.
    if (this.collections.size) {
      const ids = [...this.collections];
      this.collections.clear();
      await reconcileFolders(ids, await this.loadState());
    }
    const waitForAttanger = !force && (await attangerConvertsNewFiles());
    const now = Date.now();
    const ready = new Map<string, Intent>();
    for (const [key, m] of this.marked) {
      if (waitForAttanger && now - m.since < ATTANGER_MAX_WAIT_MS && hasFreshStoredFile(key)) {
        continue;
      }
      ready.set(key, {
        addedTo: [...m.addedTo],
        removedFrom: [...m.removedFrom],
        fill: [...m.fill],
        trash: m.trash,
        restore: m.restore,
      });
      this.marked.delete(key);
    }
    if (ready.size) {
      this.reportUnfiled(await reconcile(ready, await this.loadState()), ready);
    }
    if (this.marked.size && !force) {
      this.schedule();
    }
  }

  /**
   * Reconcile these items now, in turn with any other run, and return what
   * was done (e.g. restoring a copy on the user's request, §F2).
   */
  reconcileNow(requests: Map<string, Intent>): Promise<Reconciled[]> {
    return this.enqueue(async () => reconcile(requests, await this.loadState()));
  }

  /** Runs `work` after everything queued before it; its error reaches the caller and the log. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.then(
      () => undefined,
      (e) => log(`sync failed: ${String(e)}`),
    );
    return run;
  }

  private async loadState(): Promise<AttachmentState> {
    this.state ??= await AttachmentState.load();
    return this.state;
  }

  private clearTimers(): void {
    for (const t of [this.timer, this.startupTimer]) {
      if (t !== undefined) {
        clearTimeout(t);
      }
    }
    this.timer = undefined;
    this.startupTimer = undefined;
  }
}

/** Keys of all top-level items and standalone attachments outside the trash. */
async function allEntryKeys(): Promise<string[]> {
  const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false);
  return items.filter((i) => i.isRegularItem() || i.isAttachment()).map((i) => i.key);
}

/** Keys of the attachments of these entries (a standalone attachment is its own). */
function attachmentKeysOf(entryKeys: string[]): Set<string> {
  const keys = new Set<string>();
  for (const key of entryKeys) {
    const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
    if (!item) {
      continue;
    }
    if (item.isAttachment()) {
      keys.add(item.key);
    } else {
      for (const attachment of Zotero.Items.get(item.getAttachments()) as Zotero.Item[]) {
        keys.add(attachment.key);
      }
    }
  }
  return keys;
}

/** Key of the entry an item belongs to: its parent item's, or its own. */
function entryKey(item: Zotero.Item): string {
  const parent = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
  return parent ? parent.key : item.key;
}

/** Whether Zotero is syncing its data now. */
function syncInProgress(): boolean {
  return !!(Zotero.Sync as unknown as { Runner?: { syncInProgress?: boolean } }).Runner?.syncInProgress;
}

/** Whether Attanger is active and will move (and so convert) new stored attachments. */
async function attangerConvertsNewFiles(): Promise<boolean> {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const attanger = await AddonManager.getAddonByID(ATTANGER_ID);
  return (
    !!attanger?.isActive &&
    Zotero.Prefs.get("zoteroattanger.workMode") === "linked" &&
    Zotero.Prefs.get("zoteroattanger.autoMove") !== false
  );
}

/** A stored attachment added in the last minute, of a file type Attanger handles. */
function hasFreshStoredFile(key: string): boolean {
  const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
  if (!item) {
    return false;
  }
  const attachments = item.isAttachment() ? [item] : (Zotero.Items.get(item.getAttachments()) as Zotero.Item[]);
  const types = String(Zotero.Prefs.get("zoteroattanger.fileTypes") ?? "pdf")
    .split(",")
    .map((t) => t.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  return attachments.some((a) => {
    if (a.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_IMPORTED_FILE) {
      return false;
    }
    const added = Zotero.Date.sqlToDate(a.dateAdded, true);
    const extension = (a.attachmentFilename.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
    return !!added && Date.now() - added.getTime() < FRESH_STORED_MS && types.includes(extension);
  });
}
