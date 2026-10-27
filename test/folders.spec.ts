import { pathKey } from "../src/check/paths";
import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import { logFileFor } from "../src/sync/log";
import { AttachmentState } from "../src/sync/state";
import { getPref, setPref } from "../src/utils/prefs";

const assert: Chai.AssertStatic = chai.assert;

/*
 * Collection folders follow renamed and moved collections (requirements
 * §F5.1, Phase 3-4): whole folder at once, file by file into an existing
 * folder, descendants along with their parent, relinking, case-only
 * renames, and folders shared by two collections left alone.
 */
describe("collection folders", function () {
  this.timeout(180_000);

  let lib: TestLibrary;
  let dryRunBefore: unknown;

  const sync = () => Zotero.AttangerPlus!.sync;
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const abs = (rel: string) => PathUtils.join(lib.root, ...rel.split("/"));
  const exists = (rel: string) => IOUtils.exists(abs(rel));
  const item = (name: string) => Zotero.Items.getByLibraryAndKey(libraryID(), lib.items[name]) as Zotero.Item;
  const collection = (path: string) =>
    Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection;
  const attachments = (it: Zotero.Item) => Zotero.Items.get(it.getAttachments()) as Zotero.Item[];
  const pointsInto = (it: Zotero.Item, folder: string) => {
    for (const a of attachments(it)) {
      assert.isTrue(pathKey(a.getFilePath() as string).startsWith(pathKey(abs(folder)) + (Zotero.isWin ? "\\" : "/")), a.getFilePath() as string);
    }
  };
  const namesIn = async (rel: string) =>
    (await IOUtils.getChildren(abs(rel))).map((p) => PathUtils.filename(p));

  async function rename(c: Zotero.Collection, name: string) {
    c.name = name;
    await c.saveTx();
    await sync().flush();
  }

  before(async function () {
    dryRunBefore = getPref("dryRun");
    lib = await resetTestLibrary();
    setPref("dryRun", false);
  });

  after(function () {
    setPref("dryRun", dryRunBefore === false ? false : true);
  });

  it("moves a renamed collection's folder and relinks its attachments", async function () {
    await rename(collection("Chemistry"), "Chem Renamed");
    assert.isFalse(await exists("Chemistry"));
    assert.isTrue(await exists("Chem Renamed/Clean Item With Arxiv Version.pdf"));
    assert.isTrue(await exists("Chem Renamed/Clean Multi Collection Item.pdf"));
    pointsInto(item("ok-suffix"), "Chem Renamed");
    // Its file was missing all along: only the stored path follows.
    pointsInto(item("c3-all-missing"), "Chem Renamed");
    assert.isFalse(await exists("Chem Renamed/All Missing.pdf"));
    const state = await AttachmentState.load();
    assert.equal(state.collectionFolder(collection("Chemistry").key), "Chem Renamed");
    const log = (await IOUtils.readUTF8(logFileFor(new Date()))).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepInclude(log.find((l) => l.op === "move-folder"), { from: "Chemistry", to: "Chem Renamed", status: "done" });
  });

  it("moves a collection's folder when it gets another parent", async function () {
    const plasma = collection("Physics/Plasma");
    plasma.parentKey = collection("Chemistry").key;
    await plasma.saveTx();
    await sync().flush();
    assert.isFalse(await exists("Physics/Plasma"));
    assert.isTrue(await exists("Chem Renamed/Plasma"));
  });

  it("takes the descendants' folders along when a parent is renamed", async function () {
    await rename(collection("Physics"), "Physik");
    assert.isFalse(await exists("Physics"));
    assert.isTrue(await exists("Physik/Optics/Clean Single Collection Item.pdf"));
    assert.isTrue(await exists("Physik/Parent Direct.pdf"));
    pointsInto(item("ok-single"), "Physik/Optics");
    pointsInto(item("c2-parent-direct"), "Physik");
    const state = await AttachmentState.load();
    assert.equal(state.collectionFolder(collection("Physics/Optics").key), "Physik/Optics");
  });

  it("moves file by file into a folder that already exists, and removes the old one", async function () {
    // Physik/Renamed exists already (a stray folder of the test library).
    await rename(collection("Physics/Optics"), "Renamed");
    assert.isFalse(await exists("Physik/Optics"));
    assert.isTrue(await exists("Physik/Renamed/Clean Single Collection Item.pdf"));
    assert.isTrue(await exists("Physik/Renamed/Stale.pdf"));
    pointsInto(item("ok-single"), "Physik/Renamed");
  });

  it("changes the case of the folder name too", async function () {
    await rename(collection("Chemistry"), "chem renamed");
    assert.include(await namesIn(""), "chem renamed");
    assert.notInclude(await namesIn(""), "Chem Renamed");
  });

  it("leaves a folder alone that another collection still uses", async function () {
    const parent = collection("Physics");
    const twins: Zotero.Collection[] = [];
    for (let i = 0; i < 2; i++) {
      const c = new Zotero.Collection();
      (c as unknown as { libraryID: number }).libraryID = libraryID();
      c.name = "Twin";
      c.parentKey = parent.key;
      await c.saveTx();
      twins.push(c);
    }
    await IOUtils.makeDirectory(abs("Physik/Twin"), { ignoreExisting: true });
    await IOUtils.write(abs("Physik/Twin/Twin.pdf"), new Uint8Array([1, 2, 3]));
    await sync().flush();
    await rename(twins[0], "Twin A");
    assert.isTrue(await exists("Physik/Twin/Twin.pdf"));
    assert.isFalse(await exists("Physik/Twin A"));
  });

  it("only logs the move in dry-run mode", async function () {
    setPref("dryRun", true);
    try {
      await rename(collection("Notes Only"), "Notes Renamed");
      const last = JSON.parse((await IOUtils.readUTF8(logFileFor(new Date()))).trim().split("\n").pop()!);
      if (await exists("Notes Only")) {
        assert.deepInclude(last, { op: "move-folder", status: "dry-run", from: "Notes Only", to: "Notes Renamed" });
      }
      assert.isFalse(await exists("Notes Renamed"));
    } finally {
      setPref("dryRun", false);
    }
  });
});
