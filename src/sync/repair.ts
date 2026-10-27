import { baseOf, collectionFolder, joinRel } from "../check/paths";
import { COLLECTIONS_BUCKET, PLUGIN_TRASH } from "../check/snapshot";
import type { CheckReport, Issue } from "../check/types";
import { collectionNames } from "../utils/zotero";
import { replacedStamp } from "./changes";
import { ORPHANS_DIR, writableRoot } from "./guard";
import { execute } from "./ops";
import { eraseCollections, reconcile, restoreCollections } from "./reconcile";
import type { Intent, Operation, OpResult } from "./types";

/*
 * One-click repairs for the check report (requirements §F1.3, Phase 4-2):
 * what can be put right without a judgement call is offered in the changes
 * window, chosen by default, and carried out when the user applies it. The
 * rest of the report is for the user to handle.
 *
 * Nothing is deleted on a guess: stray files, misplaced originals and
 * plugin trash folders no item claims are set aside in the plugin trash's
 * `_orphans/` area, purged after Zotero's trash period like replaced
 * versions. Only a collection Zotero no longer has goes the way of erasing
 * it (§F5.3), which keeps what live items still need.
 */

export type Repair =
  /** C5: the file Zotero points at lies outside the item's collection folders (or outside the root). */
  | {
      kind: "misplaced";
      itemKey: string;
      itemTitle: string;
      attachmentKey: string;
      /** Relative to the root, or absolute when `outside`. */
      path: string;
      outside: boolean;
      /** The collection folder it goes to: the item's first. */
      folder: string;
    }
  /** C7: a file no attachment accounts for; `copyOf` when an attachment has the same content. */
  | { kind: "orphan"; path: string; copyOf?: string }
  /** C8: a folder no collection accounts for, with `count` files in it. */
  | { kind: "stray-folder"; path: string; count: number }
  /** C14: a trashed item's files still in collection folders. */
  | { kind: "trash-outside"; itemKey: string; itemTitle: string; paths: string[] }
  /** C14: a plugin trash folder whose item is not in Zotero's trash; `live` when it is back in the library. */
  | { kind: "trash-leftover"; path: string; key: string; count: number; live: boolean; itemTitle?: string }
  /** C14: a trashed collection's folder whose collection is not in Zotero's trash; `live` when it is back. */
  | { kind: "collection-leftover"; path: string; key: string; count: number; live: boolean; collectionPath?: string };

/** Identifies a repair within one window. */
export function repairID(r: Repair): string {
  const subject = r.kind === "misplaced" ? r.attachmentKey : r.kind === "trash-outside" ? r.itemKey : r.path;
  return `repair:${r.kind}:${subject}`;
}

/** Whether a repair is chosen by default: all but setting aside a file no attachment has the content of. */
export function repairByDefault(r: Repair): boolean {
  return !(r.kind === "orphan" && !r.copyOf);
}

/** The repairs the report's issues allow, in the order they are carried out. */
export function repairsOf(report: CheckReport): Repair[] {
  const byKind = (check: Issue["check"], kind: string) => report.issues.filter((i) => i.check === check && i.kind === kind);
  const repairs: Repair[] = [];

  // C14 first: files coming back from the plugin trash may settle C4/C5.
  const outside = new Map<string, Repair & { kind: "trash-outside" }>();
  for (const i of byKind("C14", "trashed-file-outside-trash")) {
    const entry = outside.get(i.itemKey!) ?? { kind: "trash-outside", itemKey: i.itemKey!, itemTitle: i.itemTitle ?? i.itemKey!, paths: [] };
    entry.paths.push(i.path!);
    outside.set(i.itemKey!, entry);
  }
  repairs.push(...outside.values());
  for (const i of byKind("C14", "trash-without-item")) {
    const key = i.path!.split("/")[1] ?? "";
    const item = key ? (Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key) as Zotero.Item | false) : false;
    if (item && !isLive(item)) {
      // Its parent is in Zotero's trash: the folder is not a leftover after all.
      continue;
    }
    repairs.push({
      kind: "trash-leftover",
      path: i.path!,
      key,
      count: i.count ?? 0,
      live: !!item,
      itemTitle: item ? (item.parentItem ?? item).getDisplayTitle() : undefined,
    });
  }
  for (const i of byKind("C14", "trash-without-collection")) {
    const key = i.path!.split("/")[2] ?? "";
    const collection = key ? (Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key) as Zotero.Collection | false) : false;
    repairs.push({
      kind: "collection-leftover",
      path: i.path!,
      key,
      count: i.count ?? 0,
      live: !!collection && !collection.deleted,
      collectionPath: collection ? collectionNames(collection).join("/") : undefined,
    });
  }

  for (const i of [...byKind("C5", "misplaced"), ...byKind("C5", "outside-root")]) {
    const folder = i.kind === "misplaced" ? i.related?.[0] : firstCollectionFolder(i.itemKey!);
    if (folder !== undefined) {
      repairs.push({
        kind: "misplaced",
        itemKey: i.itemKey!,
        itemTitle: i.itemTitle ?? i.itemKey!,
        attachmentKey: i.attachmentKey!,
        path: i.path!,
        outside: i.kind === "outside-root",
        folder,
      });
    }
  }
  for (const i of byKind("C7", "orphan-copy")) {
    repairs.push({ kind: "orphan", path: i.path!, copyOf: i.related?.[0] });
  }
  for (const i of byKind("C7", "orphan-unique")) {
    repairs.push({ kind: "orphan", path: i.path! });
  }
  for (const i of byKind("C8", "stray-folder")) {
    repairs.push({ kind: "stray-folder", path: i.path!, count: i.count ?? 0 });
  }
  return repairs;
}

/**
 * Carry out the chosen repairs in turn with copy maintenance (logged,
 * dry-run aware); returns every operation's result.
 */
export async function applyRepairs(repairs: Repair[], now = new Date()): Promise<OpResult[]> {
  const sync = Zotero.AttangerPlus?.sync;
  if (!sync) {
    throw new Error("Attanger Plus is not running");
  }
  const stamp = replacedStamp(now);
  // Kept under their path in the root, or in the plugin trash without its name.
  const setAside = (path: string): Operation => ({
    op: "set-aside",
    path,
    to: `${ORPHANS_DIR}/${stamp}/${path.startsWith(`${PLUGIN_TRASH}/`) ? path.slice(PLUGIN_TRASH.length + 1) : path}`,
  });
  const results: OpResult[] = [];
  const of = <K extends Repair["kind"]>(kind: K) => repairs.filter((r): r is Repair & { kind: K } => r.kind === kind);

  await sync.exclusive(async (state) => {
    const collect = (rs: { results: OpResult[] }[]) => rs.forEach((r) => results.push(...r.results));

    // C14: what the plugin would have done had it seen the change.
    const intents = new Map<string, Intent>();
    for (const r of of("trash-outside")) {
      intents.set(r.itemKey, { trash: true });
    }
    for (const r of of("trash-leftover")) {
      if (r.live) {
        const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, r.key) as Zotero.Item;
        intents.set((item.parentItem ?? item).key, { restore: true });
      }
    }
    if (intents.size) {
      collect(await reconcile(intents, state));
    }
    const unclaimed = await filesOfTrashFolders(of("trash-leftover").filter((r) => !r.live));
    if (unclaimed.length) {
      results.push(...(await execute(unclaimed.map(setAside))));
    }
    const restored = of("collection-leftover").filter((r) => r.live).map((r) => r.key);
    if (restored.length) {
      results.push(...(await restoreCollections(restored, state)));
    }
    const erased = of("collection-leftover").filter((r) => !r.live).map((r) => r.key);
    if (erased.length) {
      const { results: done, unfiled } = await eraseCollections(erased, state);
      results.push(...done);
      sync.askUnfiled(unfiled);
    }

    // C5: into the item's collection folder, Zotero pointed there, the old file set aside, copies made.
    const fill = new Map<string, Intent>();
    for (const r of of("misplaced")) {
      const to = joinRel(r.folder, r.outside ? PathUtils.filename(r.path) : baseOf(r.path));
      const ops: Operation[] = r.outside
        ? [{ op: "import", itemKey: r.itemKey, attachmentKey: r.attachmentKey, from: r.path, to }]
        : [{ op: "copy", itemKey: r.itemKey, attachmentKey: r.attachmentKey, from: r.path, to }];
      ops.push({ op: "relink", itemKey: r.itemKey, attachmentKey: r.attachmentKey, to });
      const done = await execute(ops);
      results.push(...done);
      if (done.every((d) => d.status === "done" || d.status === "unchanged")) {
        if (!r.outside) {
          results.push(...(await execute([setAside(r.path)])));
        }
        const intent = fill.get(r.itemKey) ?? { fill: [] };
        intent.fill!.push(r.attachmentKey);
        fill.set(r.itemKey, intent);
      }
    }
    if (fill.size) {
      collect(await reconcile(fill, state));
    }

    // C7, then C8 once its files are gone.
    const orphans = of("orphan").map((r) => setAside(r.path));
    if (orphans.length) {
      results.push(...(await execute(orphans)));
    }
    const folders = of("stray-folder").map((r): Operation => ({ op: "remove-empty-folder", collectionKey: "", path: r.path }));
    if (folders.length) {
      results.push(...(await execute(folders)));
    }
  });
  return results;
}

/** The files in plugin trash folders, as paths relative to the root. */
async function filesOfTrashFolders(repairs: { path: string }[]): Promise<string[]> {
  const root = writableRoot();
  const files: string[] = [];
  const walk = async (rel: string) => {
    const abs = PathUtils.join(root, ...rel.split("/"));
    if (!(await IOUtils.exists(abs))) {
      return;
    }
    for (const child of await IOUtils.getChildren(abs)) {
      const childRel = `${rel}/${PathUtils.filename(child)}`;
      if ((await IOUtils.stat(child)).type === "directory") {
        await walk(childRel);
      } else {
        files.push(childRel);
      }
    }
  };
  for (const r of repairs) {
    if (r.path.startsWith(`${PLUGIN_TRASH}/`) && !r.path.startsWith(`${PLUGIN_TRASH}/${COLLECTIONS_BUCKET}/`)) {
      await walk(r.path);
    }
  }
  return files;
}

/** An item outside Zotero's trash, its parent too. */
function isLive(item: Zotero.Item): boolean {
  return !item.deleted && !item.parentItem?.deleted;
}

/** C5 outside-root issues carry no folders: the item's first collection's. */
function firstCollectionFolder(itemKey: string): string | undefined {
  const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, itemKey) as Zotero.Item | false;
  const id = item ? item.getCollections()[0] : undefined;
  const collection = id ? (Zotero.Collections.get(id) as Zotero.Collection | false) : false;
  return collection ? collectionFolder(collectionNames(collection)) : undefined;
}
