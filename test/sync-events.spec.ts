import { runCheck } from "../src/check";
import { pathKey } from "../src/check/paths";
import { TEMP_SUFFIX } from "../src/check/snapshot";
import { makePdf } from "../src/dev/pdf";
import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import { logFileFor } from "../src/sync/log";
import { AttachmentState } from "../src/sync/state";
import { getPref, setPref } from "../src/utils/prefs";

const assert: Chai.AssertStatic = chai.assert;

/*
 * The running plugin's event-driven copy maintenance (Phase 2-3): change the
 * library the way a user would, then let the queue settle with flush().
 * The test profile has no Attanger, so new attachments stay as added.
 */
describe("sync events", function () {
  this.timeout(180_000);

  let lib: TestLibrary;
  let dryRunBefore: unknown;

  const sync = () => Zotero.AttangerPlus!.sync;
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const abs = (rel: string) => PathUtils.join(lib.root, ...rel.split("/"));
  const exists = (rel: string) => IOUtils.exists(abs(rel));
  const md5 = async (rel: string) =>
    (Zotero.Utilities.Internal as unknown as { md5Async(p: string): Promise<string> }).md5Async(abs(rel));
  const item = (name: string) => Zotero.Items.getByLibraryAndKey(libraryID(), lib.items[name]) as Zotero.Item;
  const attachmentOf = (it: Zotero.Item) => Zotero.Items.get(it.getAttachments()[0]) as Zotero.Item;
  const collection = (path: string) =>
    Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection;
  const pointsAt = (it: Zotero.Item, rel: string) =>
    assert.equal(pathKey(attachmentOf(it).getFilePath() as string), pathKey(abs(rel)));

  async function removeFromCollection(it: Zotero.Item, path: string) {
    await Zotero.DB.executeTransaction(async () => {
      await collection(path).removeItems([it.id]);
    });
  }

  before(async function () {
    dryRunBefore = getPref("dryRun");
    lib = await resetTestLibrary();
    setPref("dryRun", false);
  });

  after(function () {
    setPref("dryRun", dryRunBefore === false ? false : true);
  });

  it("copies the file into a collection the item is added to (F3.1)", async function () {
    const it = item("ok-single");
    it.addToCollection(collection("Chemistry").id);
    await it.saveTx();
    await sync().flush();
    assert.equal(await md5("Chemistry/Clean Single Collection Item.pdf"), await md5("Physics/Optics/Clean Single Collection Item.pdf"));
  });

  it("deletes the copy in a collection the item is removed from (F3.2)", async function () {
    const it = item("ok-multi");
    await removeFromCollection(it, "Chemistry");
    await sync().flush();
    assert.isFalse(await exists("Chemistry/Clean Multi Collection Item.pdf"));
    assert.isTrue(await exists("Physics/Optics/Clean Multi Collection Item.pdf"));
  });

  it("relinks to the remaining copy when the item leaves the collection Zotero points into", async function () {
    const it = item("ok-single");
    await removeFromCollection(it, "Physics/Optics");
    await sync().flush();
    pointsAt(it, "Chemistry/Clean Single Collection Item.pdf");
    assert.isFalse(await exists("Physics/Optics/Clean Single Collection Item.pdf"));
  });

  let added: Zotero.Item;

  it("gives a new linked attachment a copy in each of the item's collections (F3.4)", async function () {
    added = new Zotero.Item("journalArticle");
    added.libraryID = libraryID();
    added.setField("title", "Sync Events New Attachment");
    added.setCollections([collection("Physics/Optics").id, collection("Physics/Plasma").id]);
    await added.saveTx();
    const file = abs("Physics/Optics/New Attachment.pdf");
    await IOUtils.write(file, makePdf("sync events: new attachment"), { mode: "create" });
    await Zotero.Attachments.linkFromFile({ file, parentItemID: added.id, contentType: "application/pdf" });
    await sync().flush();
    assert.equal(await md5("Physics/Plasma/New Attachment.pdf"), await md5("Physics/Optics/New Attachment.pdf"));
    const report = await runCheck();
    assert.deepEqual(
      report.issues.filter((i) => i.severity === "problem" && i.itemKey === added.key),
      [],
    );
  });

  it("renames the copies when the attachment is renamed (F3.5)", async function () {
    assert.isTrue(await attachmentOf(added).renameAttachmentFile("Renamed Attachment.pdf"));
    await sync().flush();
    assert.isTrue(await exists("Physics/Plasma/Renamed Attachment.pdf"));
    assert.isFalse(await exists("Physics/Plasma/New Attachment.pdf"));
    const state = await AttachmentState.load();
    assert.equal(state.get(attachmentOf(added).key)?.name, "Renamed Attachment.pdf");
  });

  it("undoes Attanger's move into a folder that already holds a copy (F3.5)", async function () {
    // `added` is in Optics and Plasma, Zotero points into Optics; do what
    // Attanger's "Move Attachment" does from the Plasma view.
    const att = attachmentOf(added);
    await IOUtils.copy(abs("Physics/Optics/Renamed Attachment.pdf"), abs("Physics/Plasma/Renamed Attachment_1.pdf"));
    await att.relinkAttachmentFile(abs("Physics/Plasma/Renamed Attachment_1.pdf"));
    await IOUtils.remove(abs("Physics/Optics/Renamed Attachment.pdf"));
    await sync().flush();
    pointsAt(added, "Physics/Plasma/Renamed Attachment.pdf");
    assert.isFalse(await exists("Physics/Plasma/Renamed Attachment_1.pdf"));
    assert.equal(await md5("Physics/Optics/Renamed Attachment.pdf"), await md5("Physics/Plasma/Renamed Attachment.pdf"));
  });

  it("leaves the files alone when the item leaves its last collection (F3.3 is Phase 3)", async function () {
    await removeFromCollection(item("c2-parent-direct"), "Physics");
    await sync().flush();
    assert.isTrue(await exists("Physics/Parent Direct.pdf"));
  });

  it("leaves the files of a trashed item alone (F4 is Phase 3)", async function () {
    await Zotero.Items.trashTx([item("ok-suffix").id]);
    await sync().flush();
    assert.isTrue(await exists("Chemistry/Clean Item With Arxiv Version.pdf"));
    assert.isTrue(await exists("Chemistry/Clean Item With Arxiv Version - arxiv.pdf"));
  });

  it("only logs what it would do in dry-run mode", async function () {
    setPref("dryRun", true);
    try {
      const it = item("c10-title-a");
      it.addToCollection(collection("Chemistry").id);
      await it.saveTx();
      await sync().flush();
      assert.isFalse(await exists("Chemistry/Thermal A.pdf"));
      const last = JSON.parse((await IOUtils.readUTF8(logFileFor(new Date()))).trim().split("\n").pop()!);
      assert.deepInclude(last, { op: "copy", status: "dry-run", dryRun: true, to: "Chemistry/Thermal A.pdf" });
    } finally {
      setPref("dryRun", false);
    }
  });

  it("removes left-over temporary copies and records attachments at the startup scan", async function () {
    const temp = `Chemistry/Interrupted.pdf${TEMP_SUFFIX}`;
    await IOUtils.write(abs(temp), makePdf("sync events: interrupted"), { mode: "create" });
    await sync().scan();
    assert.isFalse(await exists(temp));
    const state = await AttachmentState.load();
    const light = attachmentOf(item("c11-article"));
    assert.deepInclude(state.get(light.key), { name: "Light Scattering.pdf", folder: "Physics/Optics" });
  });
});
