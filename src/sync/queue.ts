import { log } from "../utils/log";
import { reconcile, scanAtStartup, type Reconciled, type ScanSummary } from "./reconcile";
import { AttachmentState } from "./state";
import type { Intent } from "./types";

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
 */

/** Quiet time before marked items are reconciled. */
const QUIET_MS = 3_000;
/** Longest wait for Attanger to convert a fresh stored attachment. */
const ATTANGER_MAX_WAIT_MS = 30_000;
/** A stored attachment younger than this may still be converted by Attanger. */
const FRESH_STORED_MS = 60_000;
/** The startup scan waits until Zotero has settled. */
const STARTUP_SCAN_DELAY_MS = 10_000;

const ATTANGER_ID = "zoteroattanger@polygon.org";

interface Marked {
  addedTo: Set<number>;
  removedFrom: Set<number>;
  fill: Set<string>;
  /** When the item was first marked in this round. */
  since: number;
}

const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

export class SyncQueue {
  private marked = new Map<string, Marked>();
  private timer?: number;
  private startupTimer?: number;
  private observerID?: string;
  private paused = 0;
  private stopped = true;
  private state?: AttachmentState;
  /** All reconciling and scanning runs one at a time along this chain. */
  private chain: Promise<void> = Promise.resolve();

  start(): void {
    this.stopped = false;
    this.observerID = Zotero.Notifier.registerObserver(
      { notify: (event: string, type: string, ids: (string | number)[], extraData: Record<string, unknown>) => this.onNotify(event, type, ids, extraData) },
      ["item", "collection-item"],
      "attanger-plus",
    );
    this.scanLater();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.observerID) {
      Zotero.Notifier.unregisterObserver(this.observerID);
      this.observerID = undefined;
    }
    this.clearTimers();
    this.marked.clear();
    await this.chain;
  }

  /** Ignore events and drop marked items until resume(); waits for running work to end. */
  async pause(): Promise<void> {
    this.paused++;
    this.marked.clear();
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
      if (!this.marked.size) {
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
      if (this.paused) {
        // Try again later rather than never.
        this.scanLater();
        return;
      }
      const summary: ScanSummary = await scanAtStartup(await this.loadState());
      const removed = summary.tempFiles.filter((r) => r.status === "done").length;
      log(`sync startup scan: ${removed}/${summary.tempFiles.length} temporary files removed, ${summary.recorded} attachments recorded, ${summary.forgotten} forgotten`);
    });
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
      }
      if (this.marked.size) {
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
    if (event === "trash" || event === "delete") {
      // Zotero's trash is Phase 3 (F4); erased items need nothing. Attanger's
      // deletion of a converted stored attachment lands here too.
      for (const id of ids) {
        const item = Zotero.Items.get(Number(id));
        const key = item ? item.key : (extraData?.[id] as { key?: string } | undefined)?.key;
        if (key) {
          this.marked.delete(key);
        }
      }
      return;
    }
    if (event !== "add" && event !== "modify") {
      return;
    }
    for (const id of ids) {
      const item = Zotero.Items.get(Number(id));
      // Regular items join collections through collection-item events.
      if (!item || !item.isAttachment() || item.libraryID !== Zotero.Libraries.userLibraryID) {
        continue;
      }
      const m = this.mark(entryKey(item));
      if (event === "add" && item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE) {
        m.fill.add(item.key);
      }
    }
  }

  private mark(key: string): Marked {
    let m = this.marked.get(key);
    if (!m) {
      m = { addedTo: new Set(), removedFrom: new Set(), fill: new Set(), since: Date.now() };
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
    const waitForAttanger = !force && (await attangerConvertsNewFiles());
    const now = Date.now();
    const ready = new Map<string, Intent>();
    for (const [key, m] of this.marked) {
      if (waitForAttanger && now - m.since < ATTANGER_MAX_WAIT_MS && hasFreshStoredFile(key)) {
        continue;
      }
      ready.set(key, { addedTo: [...m.addedTo], removedFrom: [...m.removedFrom], fill: [...m.fill] });
      this.marked.delete(key);
    }
    if (ready.size) {
      await reconcile(ready, await this.loadState());
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

/** Key of the entry an item belongs to: its parent item's, or its own. */
function entryKey(item: Zotero.Item): string {
  const parent = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
  return parent ? parent.key : item.key;
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
