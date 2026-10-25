import { COLLECTIONS, EXTRA_FILES, ITEMS, resetTestLibrary } from "../src/dev/testLibrary";

const assert: Chai.AssertStatic = chai.assert;

describe("test library", function () {
  this.timeout(60_000);

  it("builds inside the scaffold test data directory", async function () {
    const lib = await resetTestLibrary();
    assert.match(lib.dataDir, /[\\/]\.scaffold[\\/]test[\\/]data$/);
    assert.sameMembers(Object.keys(lib.items), ITEMS.map((i) => i.name));
  });

  it("can be reset over an existing library without leftovers", async function () {
    const lib = await resetTestLibrary();
    const libraryID = Zotero.Libraries.userLibraryID;
    const topLevel = await Zotero.Items.getAll(libraryID, true, true);
    assert.equal(topLevel.length, ITEMS.length);
    assert.equal(Zotero.Collections.getByLibrary(libraryID, true).length, COLLECTIONS.length);
    for (const extra of EXTRA_FILES) {
      const path = PathUtils.join(lib.root, ...extra.path.split("/"));
      assert.isTrue(await IOUtils.exists(path), path);
    }
  });
});
