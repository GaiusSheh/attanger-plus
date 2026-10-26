import type { FluentMessageId } from "../typings/i10n";
import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import type { Unfiled } from "../src/sync/queue";
import { l10nID } from "../src/ui/l10n";
import { applyUnfiled, showUnfiled } from "../src/ui/unfiled";
import { getPref, setPref } from "../src/utils/prefs";

const assert: Chai.AssertStatic = chai.assert;

/*
 * Removing an item with files from its last collection (requirements §F3.3,
 * Phase 3-3): the user is asked, and chooses to put it back, trash the
 * item, or keep the item and delete its files.
 */
describe("removed from the last collection", function () {
  this.timeout(180_000);

  let lib: TestLibrary;
  let dryRunBefore: unknown;
  let onUnfiledBefore: ((items: Unfiled[]) => void) | undefined;
  let asked: Unfiled[] = [];

  const fromSync = { notifierData: { skipRenameFile: true } } as Parameters<Zotero.Item["saveTx"]>[0];
  const sync = () => Zotero.AttangerPlus!.sync;
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const abs = (rel: string) => PathUtils.join(lib.root, ...rel.split("/"));
  const exists = (rel: string) => IOUtils.exists(abs(rel));
  const item = (name: string) => Zotero.Items.getByLibraryAndKey(libraryID(), lib.items[name]) as Zotero.Item;
  const collection = (path: string) =>
    Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection;
  const attachments = (it: Zotero.Item) => Zotero.Items.get(it.getAttachments(true)) as Zotero.Item[];

  /** Remove from all its collections the way the user would, and let the queue settle. */
  async function unfile(it: Zotero.Item) {
    asked = [];
    await Zotero.DB.executeTransaction(async () => {
      for (const id of it.getCollections()) {
        await (Zotero.Collections.get(id) as Zotero.Collection).removeItems([it.id]);
      }
    });
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

  it("asks about an item with files, naming the collections it left", async function () {
    const it = item("c2-parent-direct");
    await unfile(it);
    assert.deepEqual(asked, [{ itemKey: it.key, itemTitle: it.getDisplayTitle(), removedFrom: [collection("Physics").id] }]);
    assert.isTrue(await exists("Physics/Parent Direct.pdf"));
  });

  it("puts it back into those collections on cancel", async function () {
    const it = item("c2-parent-direct");
    const applied = await applyUnfiled([{ item: asked[0], choice: "cancel" }]);
    await sync().flush();
    assert.equal(applied.cancelled, 1);
    assert.deepEqual(it.getCollections(), [collection("Physics").id]);
    assert.isTrue(await exists("Physics/Parent Direct.pdf"));
  });

  it("does not ask about an item without files, or one sync removed", async function () {
    await unfile(item("ok-notes-only"));
    assert.deepEqual(asked, []);
    const it = item("c11-article");
    asked = [];
    it.setCollections([]);
    await it.saveTx(fromSync);
    await sync().flush();
    assert.deepEqual(asked, []);
  });

  it("trashes the item with all its copies, back in the collections it left", async function () {
    const it = item("ok-multi");
    await unfile(it);
    assert.sameMembers(asked[0].removedFrom, [collection("Physics/Optics").id, collection("Chemistry").id]);
    const applied = await applyUnfiled([{ item: asked[0], choice: "trash-item" }]);
    await sync().flush();
    assert.equal(applied.trashedItems, 1);
    assert.isTrue(it.deleted);
    assert.sameMembers(it.getCollections(), [collection("Physics/Optics").id, collection("Chemistry").id]);
    const name = "Clean Multi Collection Item.pdf";
    assert.isFalse(await exists(`Physics/Optics/${name}`));
    assert.isFalse(await exists(`Chemistry/${name}`));
    assert.isTrue(await exists(`.attanger-plus-trash/${it.key}/Physics/Optics/${name}`));
    assert.isTrue(await exists(`.attanger-plus-trash/${it.key}/Chemistry/${name}`));
  });

  it("keeps the item and trashes its attachments with every copy", async function () {
    const it = item("ok-suffix");
    await unfile(it);
    const applied = await applyUnfiled([{ item: asked[0], choice: "trash-files" }]);
    await sync().flush();
    assert.equal(applied.trashedFiles, 1);
    assert.isFalse(it.deleted);
    assert.deepEqual(it.getCollections(), []);
    for (const a of attachments(it)) {
      assert.isTrue(a.deleted);
      const name = (a.getFilePath() as string).split(/[\\/]/).pop()!;
      assert.isFalse(await exists(`Chemistry/${name}`));
      assert.isTrue(await exists(`.attanger-plus-trash/${a.key}/Chemistry/${name}`));
    }
  });

  it("cancels everything when the window is closed", async function () {
    const it = item("ok-single");
    await unfile(it);
    const { win, done } = await showUnfiled(asked, { tellOutcome: false });
    win.close();
    const applied = await done;
    await sync().flush();
    assert.equal(applied?.cancelled, 1);
    assert.deepEqual(it.getCollections(), [collection("Physics/Optics").id]);
  });

  it("has the outcome messages in the main window, where they are shown after the window closed", async function () {
    const l10n = Zotero.getMainWindow().document.l10n!;
    const args = { cancelled: 1, trashedItems: 2, trashedFiles: 3 };
    for (const id of ["unfiled-done", "unfiled-dry-run"]) {
      const text = (await l10n.formatValue(l10nID(id as FluentMessageId), args)) as string | null;
      assert.isNotEmpty(text, id);
    }
  });

  it("applies the choice made in the window", async function () {
    const it = item("ok-single");
    await unfile(it);
    const { win, done } = await showUnfiled(asked, { tellOutcome: false });
    const row = win.document.querySelector(`[data-item-key="${it.key}"]`)!;
    (row.querySelector('input[value="trash-item"]') as HTMLInputElement).checked = true;
    (win.document.getElementById("apply") as HTMLButtonElement).click();
    const applied = await done;
    await sync().flush();
    assert.equal(applied?.trashedItems, 1);
    assert.isTrue(it.deleted);
    assert.isTrue(await exists(`.attanger-plus-trash/${it.key}/Physics/Optics/Clean Single Collection Item.pdf`));
  });
});
