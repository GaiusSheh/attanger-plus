import { runCheck } from "../src/check";
import { pathKey } from "../src/check/paths";
import { makePdf } from "../src/dev/pdf";
import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import {
  findingID,
  replacedStamp,
  stampDate,
  type AllMissing,
  type CopiesDiffer,
  type CopyMissing,
  type Finding,
} from "../src/sync/changes";
import { REPLACED_DIR } from "../src/sync/guard";
import { execute } from "../src/sync/ops";
import { AttachmentState } from "../src/sync/state";
import { applyDecisions, showChanges } from "../src/ui/changes";
import { getPref, setPref } from "../src/utils/prefs";

const assert: Chai.AssertStatic = chai.assert;

/* Phase 2-5: changes made in the file manager (§F3.6–F3.8) and the summary window. */
describe("file-manager changes", function () {
  this.timeout(180_000);

  let lib: TestLibrary;
  let dryRunBefore: unknown;
  let findings: Finding[];

  const sync = () => Zotero.AttangerPlus!.sync;
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const abs = (rel: string) => PathUtils.join(lib.root, ...rel.split("/"));
  const exists = (rel: string) => IOUtils.exists(abs(rel));
  const md5 = async (path: string) =>
    (Zotero.Utilities.Internal as unknown as { md5Async(p: string): Promise<string> }).md5Async(path);
  const item = (name: string) => Zotero.Items.getByLibraryAndKey(libraryID(), lib.items[name]) as Zotero.Item;
  const attachmentOf = (it: Zotero.Item) => Zotero.Items.get(it.getAttachments()[0]) as Zotero.Item;
  const collection = (path: string) =>
    Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection;
  const of = (name: string, kind: Finding["kind"]) => findings.filter((f) => f.itemKey === lib.items[name] && f.kind === kind);

  before(async function () {
    dryRunBefore = getPref("dryRun");
    lib = await resetTestLibrary();
    setPref("dryRun", false);
    findings = await sync().inspect();
  });

  after(function () {
    setPref("dryRun", dryRunBefore === false ? false : true);
  });

  it("finds deleted copies, differing copies and items with no copy left", function () {
    const differ = of("c4-copy-differs", "copies-differ") as CopiesDiffer[];
    assert.lengthOf(differ, 1);
    assert.sameMembers(differ[0].copies.map((c) => c.rel), ["Physics/Optics/Copy Differs.pdf", "Chemistry/Copy Differs.pdf"]);
    assert.deepEqual(
      (of("c4-copy-missing", "copy-missing") as CopyMissing[]).map((f) => [f.collectionPath, f.path]),
      [["Physics/Plasma", "Physics/Plasma/Copy Missing.pdf"]],
    );
    assert.lengthOf(of("c3-all-missing", "all-missing"), 1);
    // Untouched items are not reported.
    assert.deepEqual(findings.filter((f) => f.itemKey === lib.items["ok-multi"]), []);
  });

  it("points at a surviving copy when Zotero's own copy was deleted (F3.7), then reports the gap", function () {
    const it = item("c3-pointed-missing");
    assert.equal(pathKey(attachmentOf(it).getFilePath() as string), pathKey(abs("Chemistry/Pointed Missing.pdf")));
    assert.deepEqual(
      (of("c3-pointed-missing", "copy-missing") as CopyMissing[]).map((f) => f.collectionPath),
      ["Physics/Optics"],
    );
  });

  it("only logs the user's choices in dry-run mode", async function () {
    setPref("dryRun", true);
    try {
      const missing = of("c4-copy-missing", "copy-missing")[0] as CopyMissing;
      const applied = await applyDecisions([{ kind: "restore", itemKey: missing.itemKey, collectionID: missing.collectionID }]);
      assert.isTrue(applied.dryRun);
      assert.isFalse(await exists("Physics/Plasma/Copy Missing.pdf"));
    } finally {
      setPref("dryRun", false);
    }
  });

  it("syncs the chosen copy over the checked ones, keeping the old version in the plugin trash (F3.6)", async function () {
    const differ = of("c4-copy-differs", "copies-differ")[0] as CopiesDiffer;
    const oldContent = await md5(abs("Chemistry/Copy Differs.pdf"));
    const applied = await applyDecisions([
      { kind: "sync", finding: differ, from: "Physics/Optics/Copy Differs.pdf", to: ["Chemistry/Copy Differs.pdf"] },
    ]);
    assert.deepEqual(applied.failed, []);
    assert.equal(await md5(abs("Chemistry/Copy Differs.pdf")), await md5(abs("Physics/Optics/Copy Differs.pdf")));

    const stamps = await IOUtils.getChildren(abs(REPLACED_DIR));
    assert.lengthOf(stamps, 1);
    assert.isNotNull(stampDate(PathUtils.filename(stamps[0])));
    assert.equal(await md5(PathUtils.join(stamps[0], "Chemistry", "Copy Differs.pdf")), oldContent);

    const report = await runCheck();
    assert.deepEqual(report.issues.filter((i) => i.check === "C14" && (i.path ?? "").includes("_replaced")), []);
    assert.deepEqual(report.issues.filter((i) => i.check === "C4" && i.itemKey === differ.itemKey), []);
  });

  it("restores a deleted copy, or removes the item from that collection (F3.7)", async function () {
    const restore = of("c4-copy-missing", "copy-missing")[0] as CopyMissing;
    const remove = of("c3-pointed-missing", "copy-missing")[0] as CopyMissing;
    const applied = await applyDecisions([
      { kind: "restore", itemKey: restore.itemKey, collectionID: restore.collectionID },
      { kind: "remove", itemKey: remove.itemKey, collectionID: remove.collectionID },
    ]);
    assert.deepEqual(applied.failed, []);
    assert.equal(await md5(abs("Physics/Plasma/Copy Missing.pdf")), await md5(abs("Physics/Optics/Copy Missing.pdf")));
    assert.isFalse(item("c3-pointed-missing").inCollection(collection("Physics/Optics").id));
    assert.isTrue(await exists("Chemistry/Pointed Missing.pdf"));
  });

  it("refuses a backup path outside the replaced-versions area", async function () {
    const [result] = await execute([
      {
        op: "replace",
        itemKey: "X",
        attachmentKey: "Y",
        from: "Physics/Optics/Copy Missing.pdf",
        to: "Physics/Plasma/Copy Missing.pdf",
        backup: ".attanger-plus-trash/ZZZZZZZZ/Copy Missing.pdf",
      },
    ]);
    assert.deepEqual([result.status, result.reason], ["skipped", "not-in-replaced-area"]);
  });

  it("purges replaced versions older than Zotero's trash period at the startup scan", async function () {
    const days = Number(Zotero.Prefs.get("trashAutoEmptyDays") ?? 30);
    const old = `${REPLACED_DIR}/${replacedStamp(new Date(Date.now() - (days + 1) * 86_400_000))}/Chemistry/Old.pdf`;
    const recent = `${REPLACED_DIR}/${replacedStamp(new Date(Date.now() - 86_400_000))}/Chemistry/Recent.pdf`;
    for (const rel of [old, recent]) {
      await IOUtils.makeDirectory(PathUtils.parent(abs(rel))!, { createAncestors: true, ignoreExisting: true });
      await IOUtils.write(abs(rel), makePdf(rel), { mode: "create" });
    }
    await sync().scan();
    assert.isFalse(await exists(old));
    assert.isTrue(await exists(recent));
    assert.equal(stampDate(replacedStamp(new Date(0)))?.getTime(), 0);
  });

  it("syncs before restoring, so a restored copy gets the chosen version", async function () {
    // An item in three collections: one copy deleted, the other two differing.
    const it = new Zotero.Item("journalArticle");
    it.libraryID = libraryID();
    it.setField("title", "Changes Sync Then Restore");
    it.setCollections([collection("Physics/Optics").id, collection("Physics/Plasma").id, collection("Chemistry").id]);
    await it.saveTx();
    const name = "Sync Then Restore.pdf";
    await IOUtils.write(abs(`Physics/Optics/${name}`), makePdf("original"), { mode: "create" });
    await Zotero.Attachments.linkFromFile({ file: abs(`Physics/Optics/${name}`), parentItemID: it.id, contentType: "application/pdf" });
    await sync().flush();
    await IOUtils.write(abs(`Chemistry/${name}`), makePdf("edited outside Zotero"));
    await IOUtils.remove(abs(`Physics/Plasma/${name}`));

    const found = await sync().inspect([it.key]);
    const differ = found.find((f) => f.kind === "copies-differ") as CopiesDiffer;
    const missing = found.find((f) => f.kind === "copy-missing") as CopyMissing;
    assert.equal(missing.source, `Physics/Optics/${name}`, "the row says what a restore copies from");

    const applied = await applyDecisions([
      { kind: "restore", itemKey: it.key, collectionID: missing.collectionID },
      { kind: "sync", finding: differ, from: `Chemistry/${name}`, to: [`Physics/Optics/${name}`] },
    ]);
    assert.deepEqual([applied.synced, applied.restored, applied.failed.length], [1, 1, 0]);
    const chosen = await md5(abs(`Chemistry/${name}`));
    assert.equal(await md5(abs(`Physics/Optics/${name}`)), chosen);
    assert.equal(await md5(abs(`Physics/Plasma/${name}`)), chosen);
    assert.deepEqual(await sync().inspect([it.key]), []);
  });

  it("keeps finding an ignored finding, only flagged, until it is un-ignored", async function () {
    const key = lib.items["c3-all-missing"];
    const [f] = await sync().inspect([key]);
    assert.isFalse(f.ignored);
    await applyDecisions([{ kind: "ignore", findingID: findingID(f) }]);
    let [again] = await sync().inspect([key]);
    assert.equal(findingID(again), findingID(f));
    assert.isTrue(again.ignored);
    await applyDecisions([{ kind: "unignore", findingID: findingID(f) }]);
    [again] = await sync().inspect([key]);
    assert.isFalse(again.ignored);
  });

  it("relocates a lost file from anywhere, leaves the original, and forgets the ignore (F3.8)", async function () {
    const key = lib.items["c3-all-missing"];
    const [f] = (await sync().inspect([key])) as AllMissing[];
    assert.equal(f.kind, "all-missing");
    await applyDecisions([{ kind: "ignore", findingID: findingID(f) }]);

    const dir = PathUtils.join(PathUtils.tempDir, "attanger-plus-relocate");
    const found = PathUtils.join(dir, "found it.pdf");
    await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
    await IOUtils.write(found, makePdf("relocated"));
    try {
      const applied = await applyDecisions([{ kind: "relocate", finding: f, source: found }]);
      assert.deepEqual([applied.relocated, applied.failed.length], [1, 0]);
      assert.equal(await md5(abs("Chemistry/All Missing.pdf")), await md5(found));
      assert.isTrue(await IOUtils.exists(found), "the picked file stays");
      assert.deepEqual(await sync().inspect([key]), []);
      assert.notInclude((await AttachmentState.load()).ignoredIDs(), findingID(f));
    } finally {
      await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    }
  });

  it("moves a lost attachment, or its whole item, to Zotero's trash (F3.8)", async function () {
    // A deliberately deleted arXiv version: only that attachment goes.
    const withArxiv = item("ok-suffix");
    await IOUtils.remove(abs("Chemistry/Clean Item With Arxiv Version - arxiv.pdf"));
    const [lost] = (await sync().inspect([withArxiv.key])) as AllMissing[];
    assert.equal(lost.kind, "all-missing");
    let applied = await applyDecisions([{ kind: "trash-attachment", attachmentKey: lost.attachmentKey }]);
    assert.equal(applied.trashed, 1);
    assert.isTrue((Zotero.Items.getByLibraryAndKey(libraryID(), lost.attachmentKey) as Zotero.Item).deleted);
    assert.isFalse(item("ok-suffix").deleted);
    assert.isTrue(await exists("Chemistry/Clean Item With Arxiv Version.pdf"));
    assert.deepEqual(await sync().inspect([withArxiv.key]), []);

    // A paper no longer wanted: the whole item goes.
    const single = item("ok-single");
    await IOUtils.remove(abs("Physics/Optics/Clean Single Collection Item.pdf"));
    assert.equal((await sync().inspect([single.key]))[0]?.kind, "all-missing");
    applied = await applyDecisions([{ kind: "trash-item", itemKey: single.key }]);
    assert.equal(applied.trashed, 1);
    assert.isTrue(item("ok-single").deleted);
  });

  it("applies the choices made in the window, and nothing else", async function () {
    // A fresh deleted copy, and one left alone in the same window.
    await IOUtils.remove(abs("Physics/Plasma/Copy Missing.pdf"));
    await IOUtils.remove(abs("Chemistry/Clean Multi Collection Item.pdf"));
    const now = await sync().inspect([lib.items["c4-copy-missing"], lib.items["ok-multi"]]);
    assert.lengthOf(now, 2);

    const { win, done } = await showChanges(now, { tellOutcome: false });
    const key = attachmentOf(item("c4-copy-missing")).key;
    const radio = (value: string) =>
      win.document.querySelector(`[data-attachment-key="${key}"] input[value="${value}"]`) as HTMLInputElement | null;
    const apply = win.document.getElementById("apply") as HTMLButtonElement;
    assert.isTrue(radio("manual")?.checked, "nothing is chosen by default");
    assert.isTrue(apply.disabled, "Apply waits for a choice");
    radio("restore")!.click();
    assert.isFalse(apply.disabled);
    (win.document.getElementById("apply") as HTMLButtonElement).click();
    const applied = await done;
    assert.deepEqual(applied?.failed, []);
    assert.isTrue(await exists("Physics/Plasma/Copy Missing.pdf"));
    assert.isFalse(await exists("Chemistry/Clean Multi Collection Item.pdf"));
  });
});
