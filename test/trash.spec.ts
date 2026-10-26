import { runCheck } from "../src/check";
import { pathKey } from "../src/check/paths";
import { makePdf } from "../src/dev/pdf";
import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import { logFileFor } from "../src/sync/log";
import { getPref, setPref } from "../src/utils/prefs";

const assert: Chai.AssertStatic = chai.assert;

/*
 * The plugin trash follows Zotero's trash (requirements §F4, Phase 3-2):
 * trash, restore, erase, single attachments, files a live item uses
 * (known_pits A8), and the same done by sync (left to the other device).
 */
describe("plugin trash", function () {
  this.timeout(180_000);

  let lib: TestLibrary;
  let dryRunBefore: unknown;

  const fromSync = { notifierData: { skipRenameFile: true } } as Parameters<Zotero.Item["saveTx"]>[0];
  const sync = () => Zotero.AttangerPlus!.sync;
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const abs = (rel: string) => PathUtils.join(lib.root, ...rel.split("/"));
  const exists = (rel: string) => IOUtils.exists(abs(rel));
  const item = (name: string) => Zotero.Items.getByLibraryAndKey(libraryID(), lib.items[name]) as Zotero.Item;
  const attachments = (it: Zotero.Item) => Zotero.Items.get(it.getAttachments(true)) as Zotero.Item[];
  const collection = (path: string) =>
    Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection;
  const trashed = (key: string, rel: string) => `.attanger-plus-trash/${key}/${rel}`;
  const c14Of = async (key: string) =>
    (await runCheck()).issues.filter((i) => i.check === "C14" && (i.itemKey === key || (i.path ?? "").includes(key)));

  async function restore(it: Zotero.Item) {
    it.deleted = false;
    await it.saveTx();
  }

  async function newItem(title: string, collections: string[], files: { rel: string; seed: string }[]) {
    const it = new Zotero.Item("journalArticle");
    it.libraryID = libraryID();
    it.setField("title", title);
    it.setCollections(collections.map((p) => collection(p).id));
    await it.saveTx();
    for (const f of files) {
      if (!(await exists(f.rel))) {
        await IOUtils.write(abs(f.rel), makePdf(f.seed), { mode: "create" });
      }
      await Zotero.Attachments.linkFromFile({ file: abs(f.rel), parentItemID: it.id, contentType: "application/pdf" });
    }
    await sync().flush();
    return it;
  }

  before(async function () {
    dryRunBefore = getPref("dryRun");
    lib = await resetTestLibrary();
    setPref("dryRun", false);
  });

  after(function () {
    setPref("dryRun", dryRunBefore === false ? false : true);
  });

  it("moves every copy of a trashed item into the plugin trash", async function () {
    const it = item("ok-multi");
    await Zotero.Items.trashTx([it.id]);
    await sync().flush();
    const name = "Clean Multi Collection Item.pdf";
    assert.isFalse(await exists(`Physics/Optics/${name}`));
    assert.isFalse(await exists(`Chemistry/${name}`));
    assert.isTrue(await exists(trashed(it.key, `Physics/Optics/${name}`)));
    assert.isTrue(await exists(trashed(it.key, `Chemistry/${name}`)));
    assert.deepEqual(await c14Of(it.key), []);
  });

  it("brings them back when the item is restored, and removes its trash folder", async function () {
    const it = item("ok-multi");
    await restore(it);
    await sync().flush();
    const name = "Clean Multi Collection Item.pdf";
    assert.isTrue(await exists(`Physics/Optics/${name}`));
    assert.isTrue(await exists(`Chemistry/${name}`));
    assert.isFalse(await exists(`.attanger-plus-trash/${it.key}`));
    assert.equal(pathKey(attachments(it)[0].getFilePath() as string), pathKey(abs(`Physics/Optics/${name}`)));
  });

  it("trashes and restores a single attachment in its own folder", async function () {
    const it = item("ok-suffix");
    const arxiv = attachments(it).find((a) => (a.getFilePath() as string).includes("arxiv"))!;
    const rel = "Chemistry/Clean Item With Arxiv Version - arxiv.pdf";
    arxiv.deleted = true;
    await arxiv.saveTx();
    await sync().flush();
    assert.isFalse(await exists(rel));
    assert.isTrue(await exists(trashed(arxiv.key, rel)));
    assert.isTrue(await exists("Chemistry/Clean Item With Arxiv Version.pdf"));

    await restore(arxiv);
    await sync().flush();
    assert.isTrue(await exists(rel));
    assert.isFalse(await exists(`.attanger-plus-trash/${arxiv.key}`));
  });

  it("deletes the trash folder when Zotero erases the item", async function () {
    const it = item("ok-single");
    const key = it.key;
    await Zotero.Items.trashTx([it.id]);
    await sync().flush();
    assert.isTrue(await exists(`.attanger-plus-trash/${key}`));
    await it.eraseTx();
    await sync().flush();
    assert.isFalse(await exists(`.attanger-plus-trash/${key}`));
  });

  it("leaves a file a live item uses in place (known_pits A8)", async function () {
    // As after merging duplicates: the trashed item's attachment points at
    // the survivor's copy.
    const survivor = await newItem("Trash A8 Survivor", ["Physics/Plasma"], [{ rel: "Physics/Plasma/Shared.pdf", seed: "a8" }]);
    const loser = await newItem("Trash A8 Loser", ["Physics/Plasma"], [{ rel: "Physics/Plasma/Shared.pdf", seed: "a8" }]);
    await Zotero.Items.trashTx([loser.id]);
    await sync().flush();
    assert.isTrue(await exists("Physics/Plasma/Shared.pdf"));
    assert.isFalse(await exists(trashed(loser.key, "Physics/Plasma/Shared.pdf")));
    assert.isFalse(survivor.deleted);
  });

  it("restores into the collections the item belongs to now", async function () {
    const it = await newItem("Trash Moved Around", ["Physics/Optics", "Chemistry"], [
      { rel: "Physics/Optics/Moved Around.pdf", seed: "moved-around" },
    ]);
    assert.isTrue(await exists("Chemistry/Moved Around.pdf"));
    await Zotero.Items.trashTx([it.id]);
    await sync().flush();
    // While in the trash it left Chemistry and joined Plasma.
    it.setCollections([collection("Physics/Optics").id, collection("Physics/Plasma").id]);
    await it.saveTx();
    await restore(it);
    await sync().flush();
    assert.isTrue(await exists("Physics/Optics/Moved Around.pdf"));
    assert.isTrue(await exists("Physics/Plasma/Moved Around.pdf"));
    assert.isFalse(await exists("Chemistry/Moved Around.pdf"));
    // The Chemistry copy has no place: it stays in the trash, and C14 says so.
    assert.isTrue(await exists(trashed(it.key, "Chemistry/Moved Around.pdf")));
    assert.isNotEmpty(await c14Of(it.key));
  });

  it("restores the file Zotero points at into a current folder when its old one is gone", async function () {
    const it = await newItem("Trash Old Folder Gone", ["Chemistry"], [{ rel: "Chemistry/Old Folder Gone.pdf", seed: "gone" }]);
    await Zotero.Items.trashTx([it.id]);
    await sync().flush();
    it.setCollections([collection("Physics/Plasma").id]);
    await it.saveTx();
    await restore(it);
    await sync().flush();
    const att = attachments(it)[0];
    assert.equal(pathKey(att.getFilePath() as string), pathKey(abs("Physics/Plasma/Old Folder Gone.pdf")));
    assert.isFalse(await exists(`.attanger-plus-trash/${it.key}`));
  });

  it("leaves files alone when sync trashes or erases an item", async function () {
    const it = await newItem("Trash By Sync", ["Chemistry"], [{ rel: "Chemistry/By Sync.pdf", seed: "by-sync" }]);
    it.deleted = true;
    await it.saveTx(fromSync);
    await sync().flush();
    assert.isTrue(await exists("Chemistry/By Sync.pdf"));

    // Trashed here, erased by sync: the other device purged its folder.
    const other = await newItem("Erase By Sync", ["Chemistry"], [{ rel: "Chemistry/Erase By Sync.pdf", seed: "erase-sync" }]);
    await Zotero.Items.trashTx([other.id]);
    await sync().flush();
    const key = other.key;
    await other.eraseTx({ skipDeleteLog: true } as Parameters<Zotero.Item["eraseTx"]>[0]);
    await sync().flush();
    assert.isTrue(await exists(`.attanger-plus-trash/${key}`));
  });

  it("only logs the move in dry-run mode", async function () {
    const it = await newItem("Trash Dry Run", ["Chemistry"], [{ rel: "Chemistry/Dry Run Trash.pdf", seed: "dry-trash" }]);
    setPref("dryRun", true);
    try {
      await Zotero.Items.trashTx([it.id]);
      await sync().flush();
      assert.isTrue(await exists("Chemistry/Dry Run Trash.pdf"));
      const last = JSON.parse((await IOUtils.readUTF8(logFileFor(new Date()))).trim().split("\n").pop()!);
      assert.deepInclude(last, { op: "trash", status: "dry-run", path: "Chemistry/Dry Run Trash.pdf" });
    } finally {
      setPref("dryRun", false);
    }
  });
});
