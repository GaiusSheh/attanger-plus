import { config } from "../package.json";
import { runCheck } from "../src/check";
import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import { getPref, setPref } from "../src/utils/prefs";

const assert: Chai.AssertStatic = chai.assert;

/*
 * Settings (requirements §F7, Phase 4-3): the pane is registered, and the
 * master switch leaves Zotero's events alone while off, scanning again as
 * soon as it is turned back on.
 */
describe("settings", function () {
  this.timeout(180_000);

  let lib: TestLibrary;
  let dryRunBefore: unknown;

  const sync = () => Zotero.AttangerPlus!.sync;
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const exists = (rel: string) => IOUtils.exists(PathUtils.join(lib.root, ...rel.split("/")));
  const item = (name: string) => Zotero.Items.getByLibraryAndKey(libraryID(), lib.items[name]) as Zotero.Item;
  const collection = (path: string) =>
    Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection;

  before(async function () {
    dryRunBefore = getPref("dryRun");
    lib = await resetTestLibrary();
    setPref("dryRun", false);
  });

  after(function () {
    setPref("dryRun", dryRunBefore === false ? false : true);
    setPref("maintainCopies", true);
  });

  it("registers its pane in Zotero's settings", function () {
    const panes = (Zotero.PreferencePanes as unknown as { pluginPanes: { pluginID: string; src: string }[] }).pluginPanes;
    const pane = panes.find((p) => p.pluginID === config.addonID);
    assert.exists(pane);
    assert.match(pane!.src, /content\/preferences\.xhtml$/);
  });

  it("leaves Zotero's changes alone while switched off", async function () {
    setPref("maintainCopies", false);
    const it = item("ok-single");
    it.addToCollection(collection("Chemistry").id);
    await it.saveTx();
    await sync().flush();
    assert.isFalse(await exists("Chemistry/Clean Single Collection Item.pdf"));
    const missing = (await runCheck()).issues.filter((i) => i.check === "C4" && i.itemKey === it.key);
    assert.lengthOf(missing, 1, "the check still reports what was left undone");
  });

  it("scans again when switched back on, and follows changes from then on", async function () {
    assert.isFalse(getPref("maintainCopies"));
    setPref("maintainCopies", true);
    // The scan is queued by the switch; flush() runs after it.
    await sync().flush();
    const it = item("ok-single");
    it.removeFromCollection(collection("Chemistry").id);
    it.addToCollection(collection("Physics/Plasma").id);
    await it.saveTx();
    await sync().flush();
    assert.isTrue(await exists("Physics/Plasma/Clean Single Collection Item.pdf"));
  });
});
