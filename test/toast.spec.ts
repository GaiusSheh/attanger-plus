import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import { isEmpty, summarize, type Summary } from "../src/sync/summary";
import type { Operation, OpResult, OpStatus } from "../src/sync/types";
import { closeToast, describe as describeSummary, showMessages, showSummary } from "../src/ui/toast";
import { getPref, setPref } from "../src/utils/prefs";

const assert: Chai.AssertStatic = chai.assert;

/*
 * Notifications after copy maintenance (requirements §F9, Phase 4-1): what
 * a round did, summarized per item or collection; nothing when nothing was
 * done; one notification per round.
 */

const result = (operation: Operation, status: OpStatus = "done", reason?: string): OpResult => ({ operation, status, reason });
const copy = (itemKey: string, to: string): Operation => ({ op: "copy", itemKey, attachmentKey: "AAAAAAAA", from: "a.pdf", to });

describe("summary of a round", function () {
  it("counts what was done to each item, leaving out bookkeeping", function () {
    const s = summarize([
      result(copy("ITEM1111", "A/x.pdf")),
      result(copy("ITEM1111", "B/x.pdf")),
      result({ op: "delete", itemKey: "ITEM1111", attachmentKey: "AAAAAAAA", path: "C/x.pdf", keep: "A/x.pdf" }),
      result({ op: "relink", itemKey: "ITEM1111", attachmentKey: "AAAAAAAA", to: "A/x.pdf" }),
      result({ op: "purge-trash", itemKey: "ITEM1111", path: ".attanger-plus-trash/ITEM1111", onlyIfEmpty: true }),
      result(copy("ITEM2222", "A/y.pdf"), "unchanged"),
    ]);
    assert.isFalse(s.dryRun);
    assert.equal(s.problems, 0);
    assert.deepEqual(s.entries, [{ kind: "item", itemKey: "ITEM1111", actions: { copied: 2, deleted: 1 } }]);
  });

  it("is empty when everything was already in place", function () {
    const s = summarize([result(copy("ITEM1111", "A/x.pdf"), "unchanged")]);
    assert.isTrue(isEmpty(s));
  });

  it("counts problems, but not skips that are part of the design", function () {
    const s = summarize([
      result(copy("ITEM1111", "A/x.pdf"), "skipped", "target-exists-differs"),
      result({ op: "trash", itemKey: "ITEM1111", attachmentKey: "AAAAAAAA", path: "A/x.pdf", to: "t" }, "skipped", "in-use"),
      result({ op: "remove-empty-folder", collectionKey: "COLL1111", path: "Old" }, "skipped", "not-empty"),
      result(copy("ITEM2222", "B/y.pdf"), "failed", "Error: boom"),
    ]);
    assert.equal(s.problems, 2);
    assert.deepEqual(s.entries, []);
    assert.isFalse(isEmpty(s));
  });

  it("marks a dry run", function () {
    const s = summarize([result(copy("ITEM1111", "A/x.pdf"), "dry-run")]);
    assert.isTrue(s.dryRun);
    assert.deepEqual(s.entries[0].kind === "item" && s.entries[0].actions, { copied: 1 });
  });

  it("gives collections their own entries, with where a moved folder came from", function () {
    const s = summarize([
      result({ op: "move-folder", collectionKey: "COLL1111", from: "Old", to: "New" }),
      result({ op: "move-file", collectionKey: "COLL2222", from: "X/a.pdf", to: "Y/a.pdf" }),
      result({ op: "move-file", collectionKey: "COLL2222", from: "X/b.pdf", to: "Y/b.pdf" }),
      result({ op: "trash-collection", collectionKey: "COLL3333", from: "Z", to: "t" }),
    ]);
    assert.deepEqual(s.entries, [
      { kind: "collection", collectionKey: "COLL1111", actions: { moved: 1 }, movedFrom: "Old" },
      { kind: "collection", collectionKey: "COLL2222", actions: { moved: 2 } },
      { kind: "collection", collectionKey: "COLL3333", actions: { trashed: 1 } },
    ]);
  });

  it("names an erased collection by its folder and leaves out files handed to other collections", function () {
    const s = summarize(
      [
        result({ op: "untrash-collection", collectionKey: "COLL1111", from: "t/a.pdf", to: "Other/a.pdf" }),
        result({ op: "purge-collection-trash", collectionKey: "COLL1111", path: "t", onlyIfEmpty: false }),
      ],
      { erased: new Map([["COLL1111", "Gone/Folder"]]) },
    );
    assert.deepEqual(s.entries, [{ kind: "collection", collectionKey: "COLL1111", actions: { purged: 1 }, folder: "Gone/Folder" }]);
  });
});

describe("notifications", function () {
  this.timeout(180_000);

  let lib: TestLibrary;
  let dryRunBefore: unknown;
  let notifyBefore: unknown;

  const sync = () => Zotero.AttangerPlus!.sync;
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const item = (name: string) => Zotero.Items.getByLibraryAndKey(libraryID(), lib.items[name]) as Zotero.Item;
  const collection = (path: string) =>
    Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection;

  before(async function () {
    dryRunBefore = getPref("dryRun");
    notifyBefore = getPref("notify");
    lib = await resetTestLibrary();
    setPref("dryRun", false);
  });

  after(function () {
    setPref("dryRun", dryRunBefore === false ? false : true);
    setPref("notify", notifyBefore === true);
    closeToast();
  });

  it("describes items and collections in words, with the rest counted", async function () {
    const it = item("ok-multi");
    const entries: Summary["entries"] = [
      { kind: "item", itemKey: it.key, actions: { copied: 2, deleted: 1 } },
      { kind: "collection", collectionKey: collection("Physics/Optics").key, actions: { moved: 1 }, movedFrom: "Optik" },
      { kind: "item", itemKey: "GONE2345", actions: { purged: 1 } },
      ...["ok-single", "ok-suffix", "c2-parent-direct", "c3-pointed-missing", "c4-copy-missing"].map((name) => ({
        kind: "item" as const,
        itemKey: lib.items[name],
        actions: { copied: 1 },
      })),
    ];
    const lines = await describeSummary({ dryRun: false, entries, problems: 1 });
    const texts = lines.map((l) => l.text);
    assert.include(texts[0], it.getDisplayTitle());
    assert.match(texts[0], /2/);
    assert.include(texts[1], "Physics/Optics");
    assert.include(texts[1], "Optik");
    const named = entries.length - 1;
    assert.isAbove(named, 5, "the test needs more than five named entries");
    assert.equal(lines.filter((l) => l.icon).length, 5, texts.join("\n"));
    // The erased item, the entries beyond five, and the problem have lines of their own.
    assert.isTrue(lines[lines.length - 1].problem);
    assert.lengthOf(lines, 5 + 3, texts.join("\n"));
  });

  it("shows nothing when turned off, and something when on", async function () {
    const summary: Summary = { dryRun: true, entries: [{ kind: "item", itemKey: item("ok-multi").key, actions: { copied: 1 } }], problems: 0 };
    setPref("notify", false);
    assert.isNull(await showSummary(summary));
    setPref("notify", true);
    const lines = await showSummary(summary);
    assert.lengthOf(lines!, 1);
    showMessages(["plain message"]);
    closeToast();
  });

  it("tells of a rename made right after the test library was built", async function () {
    // The rebuilt library has new keys only; without recording them a
    // rename finds no previous name and the other copies stay behind.
    const told: Summary[] = [];
    const before = sync().onApplied;
    sync().onApplied = (s) => told.push(s);
    try {
      const it = item("ok-multi");
      const attachment = Zotero.Items.get(it.getAttachments()[0]) as Zotero.Item;
      assert.equal(await attachment.renameAttachmentFile("Clean Multi Renamed.pdf"), true);
      await sync().flush();
      assert.isTrue(await IOUtils.exists(PathUtils.join(lib.root, "Chemistry", "Clean Multi Renamed.pdf")));
      assert.lengthOf(told, 1);
      assert.deepEqual(told[0].entries, [{ kind: "item", itemKey: it.key, actions: { renamed: 1 } }]);
    } finally {
      sync().onApplied = before;
    }
  });

  it("tells once per round what was done, and stays quiet when nothing was", async function () {
    const told: Summary[] = [];
    const before = sync().onApplied;
    sync().onApplied = (s) => told.push(s);
    try {
      const it = item("ok-single");
      it.addToCollection(collection("Chemistry").id);
      await it.saveTx();
      await sync().flush();
      assert.lengthOf(told, 1);
      assert.deepEqual(told[0].entries, [{ kind: "item", itemKey: it.key, actions: { copied: 1 } }]);

      // An attachment edit marks the item, but its files are in place: the round says nothing.
      const attachment = Zotero.Items.get(it.getAttachments()[0]) as Zotero.Item;
      attachment.setField("title", "Renamed Title Only");
      await attachment.saveTx();
      await sync().flush();
      assert.lengthOf(told, 1);
    } finally {
      sync().onApplied = before;
    }
  });
});
