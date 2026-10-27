import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import { chooseCollections, removalChoices, removeFromCollections, topLevelItems } from "../src/ui/remove";
import { restoreCopies, revealTarget } from "../src/ui/reveal";
import { getPref, setPref } from "../src/utils/prefs";

const assert: Chai.AssertStatic = chai.assert;

/* Phase 2-4: "Remove from … Collection(s)" (§F6) and "Restore from Another Copy" (§F2). */
describe("remove and restore", function () {
  this.timeout(180_000);

  let lib: TestLibrary;
  let dryRunBefore: unknown;

  const libraryID = () => Zotero.Libraries.userLibraryID;
  const abs = (rel: string) => PathUtils.join(lib.root, ...rel.split("/"));
  const exists = (rel: string) => IOUtils.exists(abs(rel));
  const md5 = async (rel: string) =>
    (Zotero.Utilities.Internal as unknown as { md5Async(p: string): Promise<string> }).md5Async(abs(rel));
  const item = (name: string) => Zotero.Items.getByLibraryAndKey(libraryID(), lib.items[name]) as Zotero.Item;
  const attachmentOf = (it: Zotero.Item) => Zotero.Items.get(it.getAttachments()[0]) as Zotero.Item;
  const collection = (path: string) =>
    Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection;

  before(async function () {
    dryRunBefore = getPref("dryRun");
    lib = await resetTestLibrary();
    setPref("dryRun", false);
  });

  after(function () {
    setPref("dryRun", dryRunBefore === false ? false : true);
  });

  describe("item menu", function () {
    /** Right-click the item in `where` and read the removal entries' enabled state. */
    async function entries(where: Zotero.Collection | null, it: Zotero.Item) {
      const pane = Zotero.getActiveZoteroPane()!;
      const tree = pane.collectionsView as _ZoteroTypes.CollectionTree;
      if (where) {
        await tree.selectCollection(where.id);
      } else {
        await tree.selectLibrary(libraryID());
      }
      await pane.selectItem(it.id);
      await (pane as unknown as { buildItemContextMenu(): Promise<void> }).buildItemContextMenu();
      const popup = Zotero.getMainWindow().document.getElementById("zotero-itemmenu") as unknown as XULPopupElement;
      const shown = new Promise((resolve) => popup.addEventListener("popupshown", resolve, { once: true }));
      popup.openPopupAtScreen(100, 100, true);
      await shown;
      const state = Object.fromEntries(
        ["current", "all", "chosen"].map((k) => {
          const entry = popup.querySelector(`[data-l10n-id="attanger-plus-menu-remove-${k}"]`);
          return [k, entry ? entry.getAttribute("disabled") !== "true" : "missing"];
        }),
      );
      popup.hidePopup();
      return state;
    }

    it("enables each entry only where it can act", async function () {
      assert.deepEqual(await entries(collection("Physics/Optics"), item("ok-multi")), { current: true, all: true, chosen: true });
      assert.deepEqual(await entries(null, item("ok-multi")), { current: false, all: true, chosen: true });
      assert.deepEqual(await entries(null, item("c1-unfiled")), { current: false, all: false, chosen: false });
    });

    it("disables them all while copy maintenance is switched off (§F7)", async function () {
      setPref("maintainCopies", false);
      try {
        assert.deepEqual(await entries(collection("Physics/Optics"), item("ok-multi")), { current: false, all: false, chosen: false });
      } finally {
        setPref("maintainCopies", true);
      }
    });
  });

  describe("removal", function () {
    it("acts on the parents of selected attachments", function () {
      const parent = item("ok-multi");
      assert.deepEqual(topLevelItems([attachmentOf(parent), parent]).map((i) => i.key), [parent.key]);
    });

    it("offers every collection of the selected items, the current one checked", function () {
      const choices = removalChoices([item("ok-multi"), item("c4-copy-missing")], collection("Physics/Optics"));
      assert.deepEqual(
        choices.map((c) => [c.path, c.checked]),
        [
          ["Chemistry", false],
          ["Physics/Optics", true],
          ["Physics/Plasma", false],
        ],
      );
    });

    it("returns the checked collections from the dialog, or null when cancelled", async function () {
      const choices = removalChoices([item("ok-multi"), item("c4-copy-missing")], collection("Physics/Optics"));
      /** The newly opened dialog (not `previous`), once filled in. */
      const openedDialog = async (previous?: Window) => {
        for (let i = 0; i < 100; i++) {
          const win = Services.wm.getMostRecentWindow("attanger-plus:remove") as Window | null;
          if (win && win !== previous && win.document.querySelectorAll("#collections input").length === choices.length) {
            return win;
          }
          await Zotero.Promise.delay(50);
        }
        throw new Error("remove dialog did not open");
      };
      const closed = async (win: Window) => {
        for (let i = 0; i < 100 && !win.closed; i++) {
          await Zotero.Promise.delay(50);
        }
        assert.isTrue(win.closed, "dialog closes after answering");
      };

      let answer = chooseCollections(choices);
      const first = await openedDialog();
      const boxes = [...first.document.querySelectorAll("#collections input")] as unknown as HTMLInputElement[];
      boxes[0].click(); // Chemistry on
      boxes[1].click(); // Physics/Optics off
      (first.document.getElementById("ok") as HTMLButtonElement).click();
      assert.deepEqual(await answer, [collection("Chemistry").id]);
      await closed(first);

      answer = chooseCollections(choices);
      const second = await openedDialog(first);
      (second.document.getElementById("cancel") as HTMLButtonElement).click();
      assert.isNull(await answer);
      await closed(second);
    });

    it("removes the items from the chosen collections, and the copies follow", async function () {
      const it = item("ok-multi");
      assert.equal(await removeFromCollections([attachmentOf(it)], [collection("Chemistry").id]), 1);
      await Zotero.AttangerPlus!.sync.flush();
      assert.isFalse(it.inCollection(collection("Chemistry").id));
      assert.isFalse(await exists("Chemistry/Clean Multi Collection Item.pdf"));
      assert.isTrue(await exists("Physics/Optics/Clean Multi Collection Item.pdf"));
    });
  });

  describe("restore from another copy", function () {
    it("makes the missing copy in the viewed collection's folder", async function () {
      const target = (await revealTarget(attachmentOf(item("c4-copy-missing")), collection("Physics/Plasma")))!;
      assert.isFalse(target.exists);
      const result = await restoreCopies([target]);
      assert.deepEqual([result.restored.length, result.failed.length, result.dryRun], [1, 0, false]);
      assert.equal(await md5("Physics/Plasma/Copy Missing.pdf"), await md5("Physics/Optics/Copy Missing.pdf"));
    });

    it("only reports in dry-run mode", async function () {
      setPref("dryRun", true);
      try {
        const target = (await revealTarget(attachmentOf(item("c3-pointed-missing")), collection("Physics/Optics")))!;
        assert.isFalse(target.exists);
        const result = await restoreCopies([target]);
        assert.deepEqual([result.restored.length, result.failed.length, result.dryRun], [0, 1, true]);
        assert.isFalse(await exists("Physics/Optics/Pointed Missing.pdf"));
      } finally {
        setPref("dryRun", false);
      }
    });
  });
});
