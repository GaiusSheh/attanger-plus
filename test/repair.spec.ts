import { runCheck } from "../src/check";
import { pathKey } from "../src/check/paths";
import { issueID } from "../src/check/types";
import { makePdf } from "../src/dev/pdf";
import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import { purgeOps } from "../src/sync/changes";
import { applyRepairs, repairByDefault, repairsOf, type Repair } from "../src/sync/repair";
import { getPref, setPref } from "../src/utils/prefs";

const assert: Chai.AssertStatic = chai.assert;

/*
 * One-click repairs from the check report (requirements §F1.3, Phase 4-2):
 * C14 put right the way the plugin would have, C5 into the collection
 * folder, C7 set aside in `_orphans/`, C8 removed once empty; and ignoring
 * C12 notices.
 */
describe("one-click repairs", function () {
  this.timeout(180_000);

  let lib: TestLibrary;
  let dryRunBefore: unknown;

  const sync = () => Zotero.AttangerPlus!.sync;
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const abs = (rel: string) => PathUtils.join(lib.root, ...rel.split("/"));
  const exists = (rel: string) => IOUtils.exists(abs(rel));
  const item = (name: string) => Zotero.Items.getByLibraryAndKey(libraryID(), lib.items[name]) as Zotero.Item;
  const attachmentOf = (it: Zotero.Item) => Zotero.Items.get(it.getAttachments(true)[0]) as Zotero.Item;
  const collection = (path: string) =>
    Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection;
  const issues = async (check: string) => (await runCheck()).issues.filter((i) => i.check === check && !i.ignored);
  /** Files set aside in `_orphans/`, by their path below the batch folder. */
  async function setAside(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string, rel: string) => {
      for (const child of await IOUtils.getChildren(dir)) {
        const childRel = rel ? `${rel}/${PathUtils.filename(child)}` : PathUtils.filename(child);
        if ((await IOUtils.stat(child)).type === "directory") {
          await walk(child, childRel);
        } else {
          found.push(childRel.split("/").slice(1).join("/"));
        }
      }
    };
    const dir = abs(".attanger-plus-trash/_orphans");
    if (await IOUtils.exists(dir)) {
      await walk(dir, "");
    }
    return found;
  }

  before(async function () {
    dryRunBefore = getPref("dryRun");
    lib = await resetTestLibrary();
    setPref("dryRun", false);
  });

  after(function () {
    setPref("dryRun", dryRunBefore === false ? false : true);
  });

  it("offers a repair for each of C5, C7, C8 and C14, unique orphans not chosen", async function () {
    const repairs = repairsOf(await runCheck());
    const brief = repairs.map((r) => `${r.kind}:${"path" in r ? r.path : r.itemKey}:${repairByDefault(r)}`);
    assert.includeMembers(brief, [
      `trash-outside:${lib.items.trashed}:true`,
      "trash-leftover:.attanger-plus-trash/ZZZZZZZZ:true",
      "misplaced:Physics/Optics/Misplaced.pdf:true",
      "orphan:Chemistry/Orphan Copy.pdf:true",
      "orphan:Chemistry/Orphan Unique.pdf:false",
      "orphan:Physics/Renamed/Stale.pdf:false",
      "stray-folder:Old Folder:true",
      "stray-folder:Physics/Renamed:true",
    ]);
    // C14 first, as carried out.
    assert.equal(repairs[0].kind, "trash-outside");
  });

  it("carries out the default choices", async function () {
    const repairs = repairsOf(await runCheck()).filter(repairByDefault);
    await applyRepairs(repairs);

    // C14: the trashed item's file into its plugin trash folder; the unclaimed folder set aside.
    const trashed = item("trashed");
    assert.isFalse(await exists("Chemistry/Trashed.pdf"));
    assert.isTrue(await exists(`.attanger-plus-trash/${trashed.key}/Chemistry/Trashed.pdf`));
    assert.isFalse(await exists(".attanger-plus-trash/ZZZZZZZZ"));
    // C5: into Chemistry, Zotero pointed there, the old file set aside.
    const misplaced = attachmentOf(item("c5-misplaced"));
    assert.equal(pathKey(misplaced.getFilePath() as string), pathKey(abs("Chemistry/Misplaced.pdf")));
    assert.isFalse(await exists("Physics/Optics/Misplaced.pdf"));
    // C7 / C8: the copy set aside, the empty folder gone, the folder with a unique file kept.
    assert.isFalse(await exists("Chemistry/Orphan Copy.pdf"));
    assert.isTrue(await exists("Chemistry/Orphan Unique.pdf"));
    assert.isFalse(await exists("Old Folder"));
    assert.isTrue(await exists("Physics/Renamed/Stale.pdf"));
    assert.sameMembers(await setAside(), ["ZZZZZZZZ/Ghost.pdf", "Physics/Optics/Misplaced.pdf", "Chemistry/Orphan Copy.pdf"]);

    assert.deepEqual(await issues("C5"), []);
    assert.deepEqual(await issues("C14"), []);
    assert.sameMembers(
      (await issues("C7")).map((i) => i.path),
      ["Chemistry/Orphan Unique.pdf", "Physics/Renamed/Stale.pdf"],
    );
    assert.deepEqual(
      (await issues("C8")).map((i) => i.path),
      ["Physics/Renamed"],
    );
  });

  it("sets aside unique files when chosen, and then removes their folder", async function () {
    await applyRepairs(repairsOf(await runCheck()).filter((r) => r.kind === "orphan" || r.kind === "stray-folder"));
    assert.deepEqual(await issues("C7"), []);
    assert.deepEqual(await issues("C8"), []);
    assert.isFalse(await exists("Physics/Renamed"));
  });

  it("puts back the files of an item restored while the plugin was not looking", async function () {
    const it = item("ok-multi");
    const name = "Clean Multi Collection Item.pdf";
    await Zotero.Items.trashTx([it.id]);
    await sync().flush();
    assert.isTrue(await exists(`.attanger-plus-trash/${it.key}/Chemistry/${name}`));
    await sync().pause();
    try {
      it.deleted = false;
      await it.saveTx();
      await Zotero.Promise.delay(200);
    } finally {
      sync().resume();
    }
    const repairs = repairsOf(await runCheck());
    const leftover = repairs.find((r) => r.kind === "trash-leftover") as Repair & { kind: "trash-leftover" };
    assert.isTrue(leftover.live);
    await applyRepairs([leftover]);
    assert.isTrue(await exists(`Chemistry/${name}`));
    assert.isTrue(await exists(`Physics/Optics/${name}`));
    assert.isFalse(await exists(`.attanger-plus-trash/${it.key}`));
    assert.deepEqual(await issues("C14"), []);
  });

  it("moves back the folder of a collection restored while the plugin was not looking", async function () {
    const plasma = collection("Physics/Plasma");
    plasma.deleted = true;
    await plasma.saveTx();
    await sync().flush();
    assert.isFalse(await exists("Physics/Plasma"));
    await sync().pause();
    try {
      plasma.deleted = false;
      await plasma.saveTx();
      await Zotero.Promise.delay(200);
    } finally {
      sync().resume();
    }
    const leftover = repairsOf(await runCheck()).find((r) => r.kind === "collection-leftover") as Repair & {
      kind: "collection-leftover";
    };
    assert.isTrue(leftover.live);
    await applyRepairs([leftover]);
    assert.isTrue(await exists("Physics/Plasma/Thermal A.pdf"));
    assert.deepEqual(await issues("C14"), []);
  });

  it("purges set-aside files after Zotero's trash period", async function () {
    const old = ".attanger-plus-trash/_orphans/2000-01-01T00-00-00-000";
    await IOUtils.makeDirectory(abs(old), { createAncestors: true, ignoreExisting: true });
    await IOUtils.write(abs(`${old}/x.pdf`), makePdf("old orphan"), { mode: "create" });
    const ops = await purgeOps(lib.root);
    assert.deepInclude(ops, { op: "purge-replaced", path: old });
    assert.deepEqual(await issues("C14"), []);
  });

  it("leaves ignored C12 notices out of the counts, and brings them back", async function () {
    const before = await runCheck();
    const notice = before.issues.find((i) => i.check === "C12")!;
    await sync().setIssueIgnored(issueID(notice), true);
    const ignored = await runCheck();
    assert.equal(ignored.counts.C12, before.counts.C12 - 1);
    assert.isTrue(ignored.issues.find((i) => issueID(i) === issueID(notice))!.ignored);
    await sync().setIssueIgnored(issueID(notice), false);
    assert.equal((await runCheck()).counts.C12, before.counts.C12);
  });
});
