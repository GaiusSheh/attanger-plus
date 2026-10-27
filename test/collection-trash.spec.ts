import { runCheck } from "../src/check";
import { pathKey } from "../src/check/paths";
import { makePdf } from "../src/dev/pdf";
import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import { logFileFor } from "../src/sync/log";
import type { SyncQueue, Unfiled } from "../src/sync/queue";
import { applyUnfiled, showUnfiled } from "../src/ui/unfiled";
import { getPref, setPref } from "../src/utils/prefs";

const assert: Chai.AssertStatic = chai.assert;

/*
 * Collections in Zotero's trash (requirements §F5.3, Phase 3-5, Q4 A): the
 * folder goes to `.attanger-plus-trash/_collections/<key>/`, comes back on
 * restore, and goes for good when the collection is erased, except files
 * live items still point at.
 */
describe("trashed collections", function () {
  this.timeout(180_000);

  let lib: TestLibrary;
  let dryRunBefore: unknown;
  let onUnfiledBefore: SyncQueue["onUnfiled"];
  let asked: Unfiled[] = [];

  const sync = () => Zotero.AttangerPlus!.sync;
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const abs = (rel: string) => PathUtils.join(lib.root, ...rel.split("/"));
  const exists = (rel: string) => IOUtils.exists(abs(rel));
  const collection = (path: string) =>
    Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection;
  const attachmentOf = (it: Zotero.Item) => Zotero.Items.get(it.getAttachments(true)[0]) as Zotero.Item;
  const pointsAt = (it: Zotero.Item, rel: string) =>
    assert.equal(pathKey(attachmentOf(it).getFilePath() as string), pathKey(abs(rel)));
  const bucket = (c: Zotero.Collection, rel = "") => `.attanger-plus-trash/_collections/${c.key}${rel ? `/${rel}` : ""}`;
  const c14 = async () => (await runCheck()).issues.filter((i) => i.check === "C14" && (i.path ?? "").includes("_collections"));

  async function newCollection(name: string, parent?: Zotero.Collection) {
    const c = new Zotero.Collection();
    (c as unknown as { libraryID: number }).libraryID = libraryID();
    c.name = name;
    if (parent) {
      c.parentKey = parent.key;
    }
    await c.saveTx();
    await sync().flush();
    return c;
  }

  async function newItem(title: string, collections: Zotero.Collection[], file: string) {
    const it = new Zotero.Item("journalArticle");
    it.libraryID = libraryID();
    it.setField("title", title);
    it.setCollections(collections.map((c) => c.id));
    await it.saveTx();
    await IOUtils.makeDirectory(PathUtils.parent(abs(file))!, { createAncestors: true, ignoreExisting: true });
    await IOUtils.write(abs(file), makePdf(title), { mode: "create" });
    await Zotero.Attachments.linkFromFile({ file: abs(file), parentItemID: it.id, contentType: "application/pdf" });
    await sync().flush();
    return it;
  }

  async function setDeleted(c: Zotero.Collection, deleted: boolean, options?: object) {
    c.deleted = deleted;
    await c.saveTx(options as Parameters<Zotero.Collection["saveTx"]>[0]);
    await sync().flush();
  }

  before(async function () {
    dryRunBefore = getPref("dryRun");
    lib = await resetTestLibrary();
    setPref("dryRun", false);
    onUnfiledBefore = sync().onUnfiled;
    sync().onUnfiled = (items) => asked.push(...items);
  });

  after(function () {
    sync().onUnfiled = onUnfiledBefore;
    setPref("dryRun", dryRunBefore === false ? false : true);
  });

  let trashable: Zotero.Collection;
  let onlyHere: Zotero.Item;
  let both: Zotero.Item;

  it("moves a trashed collection's folder, descendants included, into the plugin trash", async function () {
    trashable = await newCollection("Trashable");
    const sub = await newCollection("Sub", trashable);
    onlyHere = await newItem("Only Here", [trashable], "Trashable/Only Here.pdf");
    both = await newItem("Both", [trashable, collection("Chemistry")], "Trashable/Both.pdf");
    await newItem("In Sub", [sub], "Trashable/Sub/In Sub.pdf");
    assert.isTrue(await exists("Chemistry/Both.pdf"));

    await setDeleted(trashable, true);
    assert.isFalse(await exists("Trashable"));
    assert.isTrue(await exists(bucket(trashable, "Trashable/Only Here.pdf")));
    assert.isTrue(await exists(bucket(trashable, "Trashable/Sub/In Sub.pdf")));
    // An item in another collection too is pointed at its copy there.
    pointsAt(both, "Chemistry/Both.pdf");
    // One only in the trashed collection has its file in the trash meanwhile, and nobody is asked.
    pointsAt(onlyHere, "Trashable/Only Here.pdf");
    assert.deepEqual(asked, []);
    assert.deepEqual(await c14(), []);
  });

  it("brings the folder back on restore", async function () {
    await setDeleted(trashable, false);
    assert.isTrue(await exists("Trashable/Only Here.pdf"));
    assert.isTrue(await exists("Trashable/Sub/In Sub.pdf"));
    assert.isTrue(await exists("Trashable/Both.pdf"));
    assert.isFalse(await exists(bucket(trashable)));
    pointsAt(onlyHere, "Trashable/Only Here.pdf");
  });

  it("restores to where the collection is now, and relinks", async function () {
    await setDeleted(trashable, true);
    trashable.name = "Trashable Moved";
    await trashable.saveTx();
    await sync().flush();
    await setDeleted(trashable, false);
    assert.isTrue(await exists("Trashable Moved/Only Here.pdf"));
    assert.isFalse(await exists("Trashable"));
    pointsAt(onlyHere, "Trashable Moved/Only Here.pdf");
    assert.isFalse(await exists(bucket(trashable)));
  });

  it("sends the files of items deleted with it to their own trash folders", async function () {
    const doomed = await newCollection("Doomed");
    const it = await newItem("Doomed Item", [doomed], "Doomed/Doomed Item.pdf");
    await setDeleted(doomed, true, { deleteItems: true });
    assert.isTrue(it.deleted);
    assert.isTrue(await exists(`.attanger-plus-trash/${it.key}/Doomed/Doomed Item.pdf`));
    assert.isFalse(await exists("Doomed/Doomed Item.pdf"));

    // Emptying the trash leaves no empty folder of it behind.
    const key = doomed.key;
    await Zotero.Collections.erase([doomed.id]);
    await sync().flush();
    assert.isFalse(await exists(`.attanger-plus-trash/_collections/${key}`));
  });

  /** Trash and erase a collection holding one item only there and one also in Chemistry. */
  async function eraseWithItems(name: string) {
    const c = await newCollection(name);
    const only = await newItem(`${name} Only`, [c], `${name}/${name} Only.pdf`);
    const elsewhere = await newItem(`${name} Elsewhere`, [c, collection("Chemistry")], `${name}/${name} Elsewhere.pdf`);
    await setDeleted(c, true);
    pointsAt(elsewhere, `Chemistry/${name} Elsewhere.pdf`);
    asked = [];
    const key = c.key;
    await Zotero.Collections.erase([c.id]);
    await sync().flush();
    return { key, only, bucket: `.attanger-plus-trash/_collections/${key}` };
  }

  it("asks about the items an erased collection leaves in no collection, and keeps their files meanwhile", async function () {
    const { key, only, bucket } = await eraseWithItems("Gone");
    assert.lengthOf(asked, 1);
    assert.equal(asked[0].itemKey, only.key);
    assert.deepInclude(asked[0].erased!, { collectionKey: key, collectionName: "Gone" });
    assert.isTrue(await exists(`${bucket}/Gone/Gone Only.pdf`));
    // The other item's copy there is not needed: it has its own in Chemistry.
    assert.isTrue(await exists("Chemistry/Gone Elsewhere.pdf"));

    // Its default: the item goes to the trash, its file to the item's trash folder.
    const applied = await applyUnfiled([{ item: asked[0], choice: "trash-item" }]);
    await sync().flush();
    assert.equal(applied.trashedItems, 1);
    assert.isTrue(only.deleted);
    assert.isTrue(await exists(`.attanger-plus-trash/${only.key}/Gone/Gone Only.pdf`));
    assert.isFalse(await exists(bucket));
    assert.isFalse(await exists("Gone"));
  });

  it("deletes an erased collection's item and its files for good on request", async function () {
    const { only, bucket } = await eraseWithItems("Purged");
    const key = only.key;
    const applied = await applyUnfiled([{ item: asked[0], choice: "erase-item" }]);
    await sync().flush();
    assert.equal(applied.erasedItems, 1);
    assert.isFalse(Zotero.Items.getByLibraryAndKey(libraryID(), key));
    assert.isFalse(await exists(`.attanger-plus-trash/${key}`));
    assert.isFalse(await exists(bucket));
    assert.isFalse(await exists("Purged"));
  });

  it("keeps an erased collection's item and its files in the files root on request", async function () {
    const { only, bucket } = await eraseWithItems("Kept");
    await applyUnfiled([{ item: asked[0], choice: "keep" }]);
    await sync().flush();
    assert.isFalse(only.deleted);
    pointsAt(only, "Kept Only.pdf");
    assert.isFalse(await exists(bucket));
    assert.isFalse(await exists("Kept"));
  });

  it("keeps an erased collection's item and trashes its attachments on request", async function () {
    const { only, bucket } = await eraseWithItems("Bare");
    await applyUnfiled([{ item: asked[0], choice: "trash-files" }]);
    await sync().flush();
    assert.isFalse(only.deleted);
    const att = attachmentOf(only);
    assert.isTrue(att.deleted);
    assert.isTrue(await exists(`.attanger-plus-trash/${att.key}/Bare/Bare Only.pdf`));
    assert.isFalse(await exists(bucket));
  });

  it("trashes an erased collection's item when the window is just closed", async function () {
    const { only, bucket } = await eraseWithItems("Closed");
    const { win, done } = await showUnfiled(asked, { tellOutcome: false });
    win.close();
    const applied = await done;
    await sync().flush();
    assert.equal(applied?.trashedItems, 1);
    assert.isTrue(only.deleted);
    assert.isFalse(await exists(bucket));
  });

  it("leaves the trash folder when sync erases the collection", async function () {
    const remote = await newCollection("Remote");
    await newItem("Remote Item", [remote], "Remote/Remote Item.pdf");
    await setDeleted(remote, true);
    const key = remote.key;
    await Zotero.Collections.erase([remote.id], { skipDeleteLog: true } as object);
    await sync().flush();
    assert.isTrue(await exists(`.attanger-plus-trash/_collections/${key}`));
  });

  it("only logs the move in dry-run mode", async function () {
    const dry = await newCollection("Dry");
    await newItem("Dry Item", [dry], "Dry/Dry Item.pdf");
    setPref("dryRun", true);
    try {
      await setDeleted(dry, true);
      assert.isTrue(await exists("Dry/Dry Item.pdf"));
      const last = JSON.parse((await IOUtils.readUTF8(logFileFor(new Date()))).trim().split("\n").pop()!);
      assert.deepInclude(last, { op: "trash-collection", status: "dry-run", from: "Dry" });
    } finally {
      setPref("dryRun", false);
    }
  });
});
