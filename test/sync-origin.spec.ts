import { pathKey } from "../src/check/paths";
import { makePdf } from "../src/dev/pdf";
import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import { AttachmentState } from "../src/sync/state";
import { getPref, setPref } from "../src/utils/prefs";

const assert: Chai.AssertStatic = chai.assert;

/*
 * Changes brought in by Zotero sync belong to the device that made them; its
 * files come through the user's file sync (Phase 3 plan, 3-1). Sync saves
 * with `skipRenameFile` in the event data, which is what these tests do.
 */
describe("changes from Zotero sync", function () {
  this.timeout(180_000);

  let lib: TestLibrary;
  let dryRunBefore: unknown;

  const fromSync = { notifierData: { skipRenameFile: true } } as Parameters<Zotero.Item["saveTx"]>[0];
  const sync = () => Zotero.AttangerPlus!.sync;
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const abs = (rel: string) => PathUtils.join(lib.root, ...rel.split("/"));
  const exists = (rel: string) => IOUtils.exists(abs(rel));
  const item = (name: string) => Zotero.Items.getByLibraryAndKey(libraryID(), lib.items[name]) as Zotero.Item;
  const attachmentOf = (it: Zotero.Item) => Zotero.Items.get(it.getAttachments()[0]) as Zotero.Item;
  const collection = (path: string) =>
    Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection;
  const record = async (attachment: Zotero.Item) => (await AttachmentState.load()).get(attachment.key);

  before(async function () {
    dryRunBefore = getPref("dryRun");
    lib = await resetTestLibrary();
    setPref("dryRun", false);
  });

  after(function () {
    setPref("dryRun", dryRunBefore === false ? false : true);
  });

  it("makes no copy when sync adds an item to a collection", async function () {
    const it = item("ok-single");
    it.addToCollection(collection("Chemistry").id);
    await it.saveTx(fromSync);
    await sync().flush();
    assert.isFalse(await exists("Chemistry/Clean Single Collection Item.pdf"));
  });

  it("deletes no copy when sync removes an item from a collection", async function () {
    const it = item("ok-multi");
    it.removeFromCollection(collection("Chemistry").id);
    await it.saveTx(fromSync);
    await sync().flush();
    assert.isTrue(await exists("Chemistry/Clean Multi Collection Item.pdf"));
  });

  it("still maintains a change made here right after a synced one", async function () {
    // ok-single was just added to Chemistry by sync, with no copy there.
    const it = item("ok-single");
    it.addToCollection(collection("Physics/Plasma").id);
    await it.saveTx();
    await sync().flush();
    assert.isTrue(await exists("Physics/Plasma/Clean Single Collection Item.pdf"));
    // The synced collection is the other device's to fill.
    assert.isFalse(await exists("Chemistry/Clean Single Collection Item.pdf"));
  });

  it("still maintains a collection change made here after sync changed the item's fields", async function () {
    const it = item("ok-suffix");
    it.setField("extra", "changed on another device");
    await it.saveTx(fromSync);
    it.addToCollection(collection("Physics/Optics").id);
    await it.saveTx();
    await sync().flush();
    assert.isTrue(await exists("Physics/Optics/Clean Item With Arxiv Version.pdf"));
    assert.isTrue(await exists("Physics/Optics/Clean Item With Arxiv Version - arxiv.pdf"));
  });

  let renamed: Zotero.Item;

  it("leaves the copies alone and follows the record when sync renames an attachment", async function () {
    renamed = new Zotero.Item("journalArticle");
    renamed.libraryID = libraryID();
    renamed.setField("title", "Sync Origin Rename");
    renamed.setCollections([collection("Physics/Optics").id, collection("Physics/Plasma").id]);
    await renamed.saveTx();
    const file = abs("Physics/Optics/Before.pdf");
    await IOUtils.write(file, makePdf("sync origin: rename"), { mode: "create" });
    await Zotero.Attachments.linkFromFile({ file, parentItemID: renamed.id, contentType: "application/pdf" });
    await sync().flush();
    assert.isTrue(await exists("Physics/Plasma/Before.pdf"));

    // The other device renamed both copies; file sync has delivered only
    // the one Zotero points at so far.
    const att = attachmentOf(renamed);
    await IOUtils.move(file, abs("Physics/Optics/After.pdf"));
    att.attachmentPath = abs("Physics/Optics/After.pdf");
    await att.saveTx(fromSync);
    await sync().flush();
    assert.isTrue(await exists("Physics/Plasma/Before.pdf"));
    assert.isFalse(await exists("Physics/Plasma/After.pdf"));
    assert.deepInclude(await record(att), { name: "After.pdf", folder: "Physics/Optics" });
  });

  it("records a synced path whose file has not arrived yet", async function () {
    const att = attachmentOf(renamed);
    att.attachmentPath = abs("Physics/Optics/Not Yet.pdf");
    await att.saveTx(fromSync);
    await sync().flush();
    assert.deepInclude(await record(att), { name: "Not Yet.pdf", folder: "Physics/Optics" });
  });

  it("makes no copies for an attachment added by sync, and records it", async function () {
    const it = new Zotero.Item("journalArticle");
    it.libraryID = libraryID();
    it.setField("title", "Sync Origin New Attachment");
    it.setCollections([collection("Physics/Optics").id, collection("Chemistry").id]);
    await it.saveTx(fromSync);
    const file = abs("Physics/Optics/From Elsewhere.pdf");
    await IOUtils.write(file, makePdf("sync origin: new attachment"), { mode: "create" });
    const att = new Zotero.Item("attachment");
    att.libraryID = libraryID();
    att.parentID = it.id;
    att.attachmentLinkMode = Zotero.Attachments.LINK_MODE_LINKED_FILE;
    att.attachmentContentType = "application/pdf";
    att.attachmentPath = file;
    await att.saveTx(fromSync);
    await sync().flush();
    assert.isFalse(await exists("Chemistry/From Elsewhere.pdf"));
    assert.deepInclude(await record(att), { name: "From Elsewhere.pdf", folder: "Physics/Optics" });
    assert.equal(pathKey(att.getFilePath() as string), pathKey(file));
  });
});
