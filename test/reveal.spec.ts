import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import { fileAttachmentsOf, hasFiles, revealTarget } from "../src/ui/reveal";

const assert: Chai.AssertStatic = chai.assert;

describe("show file in current collection folder", function () {
  this.timeout(120_000);

  let lib: TestLibrary;
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const item = (name: string) => Zotero.Items.getByLibraryAndKey(libraryID(), lib.items[name]) as Zotero.Item;
  const collection = (path: string) =>
    Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection;
  const firstFile = async (name: string) => (await fileAttachmentsOf([item(name)]))[0];
  const target = async (name: string, path: string | null) =>
    (await revealTarget(await firstFile(name), path === null ? null : collection(path)))!;
  const rel = (abs: string) => abs.slice(lib.root.length + 1).replace(/\\/g, "/");

  before(async function () {
    lib = await resetTestLibrary();
  });

  it("shows the copy in the collection being viewed", async function () {
    const inChemistry = await target("ok-multi", "Chemistry");
    const inOptics = await target("ok-multi", "Physics/Optics");
    assert.isTrue(inChemistry.exists);
    assert.isTrue(inOptics.exists);
    assert.match(rel(inChemistry.path), /^Chemistry\//);
    assert.match(rel(inOptics.path), /^Physics\/Optics\//);
    assert.equal(PathUtils.filename(inChemistry.path), PathUtils.filename(inOptics.path));
  });

  it("finds the collection's copy even when Zotero's own copy is gone", async function () {
    const t = await target("c3-pointed-missing", "Chemistry");
    assert.equal(rel(t.path), "Chemistry/Pointed Missing.pdf");
    assert.isTrue(t.exists);
  });

  it("reports a missing copy for the viewed collection", async function () {
    const t = await target("c4-copy-missing", "Physics/Plasma");
    assert.equal(rel(t.path), "Physics/Plasma/Copy Missing.pdf");
    assert.isFalse(t.exists);
    assert.equal(t.collection?.key, lib.collections["Physics/Plasma"]);
  });

  it("falls back to Zotero's copy outside a collection view or a foreign collection", async function () {
    const noCollection = await target("ok-multi", null);
    assert.isNull(noCollection.collection);
    assert.match(rel(noCollection.path), /^Physics\/Optics\//);
    const foreign = await target("ok-single", "Chemistry");
    assert.isNull(foreign.collection);
    assert.match(rel(foreign.path), /^Physics\/Optics\//);
  });

  it("uses the stored file for stored attachments", async function () {
    const t = await target("c6-stored", "Chemistry");
    assert.isNull(t.collection);
    assert.isTrue(t.exists);
    assert.isTrue(t.path.startsWith(Zotero.DataDirectory.dir));
  });

  it("picks file attachments: the attachment itself, one per regular item, none for notes-only items", async function () {
    const parent = item("ok-suffix");
    const firstAttachment = Zotero.Items.get(parent.getAttachments()[0]) as Zotero.Item;
    assert.lengthOf(await fileAttachmentsOf([parent]), 1);
    assert.deepEqual((await fileAttachmentsOf([firstAttachment, firstAttachment])).map((a) => a.id), [firstAttachment.id]);
    assert.lengthOf(await fileAttachmentsOf([item("ok-notes-only")]), 0);
    assert.isFalse(hasFiles([item("ok-notes-only")]));
    assert.isTrue(hasFiles([item("ok-single")]));
  });

  it("adds an enabled entry to the item context menu", async function () {
    const pane = Zotero.getActiveZoteroPane()!;
    await pane.selectItem(item("ok-single").id);
    // A right click runs this first; plugin entries are inserted here, not on popupshowing.
    await (pane as unknown as { buildItemContextMenu(): Promise<void> }).buildItemContextMenu();
    const popup = Zotero.getMainWindow().document.getElementById("zotero-itemmenu") as unknown as XULPopupElement;
    const shown = new Promise((resolve) => popup.addEventListener("popupshown", resolve, { once: true }));
    popup.openPopupAtScreen(100, 100, true);
    await shown;
    const entry = popup.querySelector('[data-l10n-id="attanger-plus-menu-reveal"]');
    const disabled = entry?.getAttribute("disabled") === "true";
    popup.hidePopup();
    assert.isNotNull(entry);
    assert.isFalse(disabled);
  });
});
