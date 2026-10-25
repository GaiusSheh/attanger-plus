import { runCheck, type CheckReport, type Issue } from "../src/check";
import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";

const assert: Chai.AssertStatic = chai.assert;

describe("check", function () {
  this.timeout(120_000);

  let lib: TestLibrary;
  let report: CheckReport;

  before(async function () {
    lib = await resetTestLibrary();
    report = await runCheck();
  });

  const issues = (check: Issue["check"], kind?: string) =>
    report.issues.filter((i) => i.check === check && (!kind || i.kind === kind));
  const itemKeys = (list: Issue[]) => list.map((i) => i.itemKey).sort();
  const keys = (...names: string[]) => names.map((n) => lib.items[n]).sort();
  const paths = (list: Issue[]) => list.map((i) => i.path).sort();

  it("reports no configuration problem in the test profile", function () {
    assert.deepEqual(report.config, []);
    assert.equal(report.root, lib.root);
  });

  it("C1 finds the item in no collection", function () {
    assert.deepEqual(itemKeys(issues("C1")), keys("c1-unfiled"));
  });

  it("C2 finds the item placed directly in a parent collection", function () {
    const found = issues("C2");
    assert.deepEqual(itemKeys(found), keys("c2-parent-direct"));
    assert.equal(found[0].collectionPath, "Physics");
  });

  it("C3 tells a missing pointed copy from a file missing everywhere", function () {
    const pointed = issues("C3", "pointed-missing");
    assert.deepEqual(itemKeys(pointed), keys("c3-pointed-missing"));
    assert.deepEqual(pointed[0].related, ["Chemistry/Pointed Missing.pdf"]);
    assert.deepEqual(itemKeys(issues("C3", "all-missing")), keys("c3-all-missing"));
    assert.lengthOf(issues("C3"), 2);
  });

  it("C4 finds the missing and the differing copy", function () {
    assert.deepEqual(paths(issues("C4", "copy-missing")), ["Physics/Plasma/Copy Missing.pdf"]);
    assert.deepEqual(paths(issues("C4", "copy-differs")), ["Chemistry/Copy Differs.pdf"]);
    assert.lengthOf(issues("C4"), 2);
  });

  it("C5 finds the file outside the item's collection folders", function () {
    const found = issues("C5");
    assert.deepEqual(itemKeys(found), keys("c5-misplaced"));
    assert.equal(found[0].kind, "misplaced");
    assert.deepEqual(found[0].related, ["Chemistry"]);
  });

  it("C6 finds the stored attachment", function () {
    assert.deepEqual(itemKeys(issues("C6", "stored")), keys("c6-stored"));
    assert.lengthOf(issues("C6"), 1);
  });

  it("C7 tells orphan copies from orphans with unique content", function () {
    const copies = issues("C7", "orphan-copy");
    assert.deepEqual(paths(copies), ["Chemistry/Orphan Copy.pdf"]);
    assert.match(copies[0].related![0], /^Physics\/Optics\//);
    assert.deepEqual(paths(issues("C7", "orphan-unique")), ["Chemistry/Orphan Unique.pdf", "Physics/Renamed/Stale.pdf"]);
    assert.lengthOf(issues("C7"), 3);
  });

  it("C8 reports only the topmost stray folders, with their file counts", function () {
    const found = issues("C8").map((i) => [i.path, i.count]);
    assert.sameDeepMembers(found, [
      ["Old Folder", 0],
      ["Physics/Renamed", 1],
    ]);
  });

  it("C9 finds the empty collection and the collection without folder", function () {
    assert.deepEqual(issues("C9", "empty").map((i) => i.collectionPath), ["Physics/Empty"]);
    assert.deepEqual(issues("C9", "no-folder").map((i) => i.collectionPath), ["Notes Only"]);
  });

  it("C10 groups duplicates by DOI and by title", function () {
    const byDOI = issues("C10", "same-doi");
    const byTitle = issues("C10", "same-title");
    assert.lengthOf(byDOI, 1);
    assert.lengthOf(byTitle, 1);
    assert.sameMembers([byDOI[0].itemKey!, ...byDOI[0].related!], keys("c10-doi-a", "c10-doi-b"));
    assert.sameMembers([byTitle[0].itemKey!, ...byTitle[0].related!], keys("c10-title-a", "c10-title-b"));
  });

  it("C11 links the webpage item to its article", function () {
    const found = issues("C11");
    assert.deepEqual(itemKeys(found), keys("c11-webpage"));
    assert.deepEqual(found[0].related, keys("c11-article"));
  });

  it("C12 flags download suffixes, and accepts template names with a ' - suffix'", function () {
    assert.deepEqual(itemKeys(issues("C12", "download-suffix")), keys("c12-paren-1", "c12-space-2"));
    // "Misplaced.pdf" for an item titled "Misplaced File"
    const misnamed = issues("C12", "name-template").find((i) => i.itemKey === lib.items["c5-misplaced"]);
    assert.deepEqual(misnamed?.related, ["Misplaced File"]);
    const flagged = new Set(issues("C12").map((i) => i.itemKey));
    for (const name of ["ok-single", "ok-multi", "ok-suffix"]) {
      assert.isFalse(flagged.has(lib.items[name]), name);
    }
  });

  it("C14 finds the orphaned trash folder and the trashed item's file", function () {
    assert.deepEqual(paths(issues("C14", "trash-without-item")), [".attanger-plus-trash/ZZZZZZZZ"]);
    const outside = issues("C14", "trashed-file-outside-trash");
    assert.deepEqual(itemKeys(outside), keys("trashed"));
    assert.deepEqual(paths(outside), ["Chemistry/Trashed.pdf"]);
  });

  it("says nothing about the clean items", function () {
    const clean = new Set(keys("ok-single", "ok-multi", "ok-suffix", "ok-notes-only"));
    const noise = report.issues.filter((i) => i.itemKey && clean.has(i.itemKey));
    assert.deepEqual(noise, []);
  });

  it("changes nothing on disk or in the library, and reuses hashes", async function () {
    const before = await listTree(lib.root);
    const itemCount = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false, true)).length;
    const again = await runCheck();
    assert.deepEqual(await listTree(lib.root), before);
    assert.equal((await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false, true)).length, itemCount);
    assert.deepEqual(again.issues, report.issues);
    assert.equal(again.stats.hashed, 0);
  });

  it("falls back to library-only checks without a files root", async function () {
    const saved = Zotero.Prefs.get("baseAttachmentPath") as string;
    Zotero.Prefs.set("baseAttachmentPath", "");
    try {
      const partial = await runCheck();
      assert.deepEqual(partial.config.map((n) => n.kind), ["root-unset"]);
      assert.deepEqual(itemKeys(partial.issues.filter((i) => i.check === "C1")), keys("c1-unfiled"));
      assert.lengthOf(partial.issues.filter((i) => i.check === "C3" || i.check === "C7"), 0);
    } finally {
      Zotero.Prefs.set("baseAttachmentPath", saved);
    }
  });
});

/** Every path under `root` with its size and modification time. */
async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const child of await IOUtils.getChildren(dir)) {
      const info = await IOUtils.stat(child);
      out.push(`${child}|${info.type}|${info.size}|${info.lastModified}`);
      if (info.type === "directory") {
        await walk(child);
      }
    }
  }
  await walk(root);
  return out.sort();
}
