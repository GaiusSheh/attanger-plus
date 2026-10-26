import { runCheck } from "../src/check";
import { Hasher } from "../src/check/hash";
import { pathKey } from "../src/check/paths";
import { takeSnapshot, TEMP_SUFFIX } from "../src/check/snapshot";
import { makePdf } from "../src/dev/pdf";
import { resetTestLibrary, type TestLibrary } from "../src/dev/testLibrary";
import { resolveInRoot, Skip, writableRoot } from "../src/sync/guard";
import { logFileFor } from "../src/sync/log";
import { execute } from "../src/sync/ops";
import { planEntry } from "../src/sync/plan";
import { AttachmentState, stateFile } from "../src/sync/state";
import type { Intent, Operation } from "../src/sync/types";
import { getPref, isDryRun, setPref } from "../src/utils/prefs";

const assert: Chai.AssertStatic = chai.assert;

describe("sync", function () {
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
  const collectionID = (path: string) =>
    (Zotero.Collections.getByLibraryAndKey(libraryID(), lib.collections[path]) as Zotero.Collection).id;

  async function planFor(it: Zotero.Item, intent?: Intent, state?: AttachmentState) {
    const snapshot = await takeSnapshot(lib.root);
    const entry = snapshot.entries.find((e) => e.key === it.key);
    if (!entry) {
      throw new Error(`no entry for ${it.key}`);
    }
    return planEntry(snapshot, entry, new Hasher(), { intent, state });
  }

  /** Every file under the root, with size and mtime, plugin trash included. */
  async function tree(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    async function walk(dir: string, rel: string) {
      for (const child of await IOUtils.getChildren(dir)) {
        const childRel = rel ? `${rel}/${PathUtils.filename(child)}` : PathUtils.filename(child);
        const info = await IOUtils.stat(child);
        if (info.type === "directory") {
          await walk(child, childRel);
        } else {
          out.set(childRel, `${info.size}:${info.lastModified}`);
        }
      }
    }
    await walk(lib.root, "");
    return out;
  }

  /** A new item with one linked file at `folder/name`, in `collections`. */
  async function makeItem(title: string, collections: string[], folder: string, name: string) {
    const it = new Zotero.Item("journalArticle");
    it.libraryID = libraryID();
    it.setField("title", title);
    it.setCollections(collections.map(collectionID));
    await it.saveTx();
    const rel = folder ? `${folder}/${name}` : name;
    await IOUtils.makeDirectory(PathUtils.parent(abs(rel))!, { createAncestors: true, ignoreExisting: true });
    await IOUtils.write(abs(rel), makePdf(`sync spec: ${title}`), { mode: "create" });
    await Zotero.Attachments.linkFromFile({ file: abs(rel), parentItemID: it.id, contentType: "application/pdf" });
    return it;
  }

  /** Check problems (not notices: test file names ignore the naming template) about an item or files named `name`. */
  async function checkIssuesAbout(it: Zotero.Item, name: string) {
    const report = await runCheck();
    return report.issues.filter(
      (i) => i.severity === "problem" && (i.itemKey === it.key || (i.path ?? "").endsWith(`/${name}`)),
    );
  }

  before(async function () {
    dryRunBefore = getPref("dryRun");
    lib = await resetTestLibrary();
  });

  after(function () {
    setPref("dryRun", dryRunBefore === false ? false : true);
  });

  describe("settings and guards", function () {
    it("starts in dry-run mode by default", function () {
      assert.strictEqual(dryRunBefore, true);
      assert.isTrue(isDryRun());
    });

    it("accepts plain paths inside the root and rejects everything else", function () {
      assert.equal(resolveInRoot(lib.root, "Physics/Optics/a.pdf"), PathUtils.join(lib.root, "Physics", "Optics", "a.pdf"));
      const reasons = ["", "../a.pdf", "Physics/../../a.pdf", "/a.pdf", "C:/a.pdf", "a\\b.pdf", "Physics//a.pdf", ".attanger-plus-trash/K/a.pdf"].map(
        (rel) => {
          try {
            resolveInRoot(lib.root, rel);
            return "accepted";
          } catch (e) {
            return e instanceof Skip ? e.reason : String(e);
          }
        },
      );
      assert.deepEqual(reasons, [
        "not-a-relative-path",
        "bad-path-segment",
        "bad-path-segment",
        "not-a-relative-path",
        "not-a-relative-path",
        "not-a-relative-path",
        "bad-path-segment",
        "in-plugin-trash",
      ]);
    });

    it("writes only into the test library's root", function () {
      assert.equal(pathKey(writableRoot()), pathKey(lib.root));
    });

    it("refuses any other root while the data directory is a test one (known_pits C8)", async function () {
      const saved = Zotero.Prefs.get("baseAttachmentPath") as string;
      Zotero.Prefs.set("baseAttachmentPath", PathUtils.join(PathUtils.tempDir, "attanger-plus-elsewhere"));
      try {
        assert.throws(() => writableRoot(), /Refusing to write outside the test library/);
        let thrown: unknown;
        try {
          await execute([{ op: "relink", itemKey: "X", attachmentKey: "Y", to: "a.pdf" }], { dryRun: true });
        } catch (e) {
          thrown = e;
        }
        assert.match(String(thrown), /Refusing to write outside the test library/);
      } finally {
        Zotero.Prefs.set("baseAttachmentPath", saved);
      }
    });
  });

  describe("plan", function () {
    it("plans nothing for an item whose copies are all in place", async function () {
      const plan = await planFor(item("ok-multi"));
      assert.deepEqual(plan, { operations: [], notes: [] });
    });

    it("only notes a missing copy when there is no intent", async function () {
      const plan = await planFor(item("c4-copy-missing"));
      assert.deepEqual(plan.operations, []);
      assert.deepEqual(
        plan.notes.map((n) => [n.kind, n.path]),
        [["copy-missing", "Physics/Plasma/Copy Missing.pdf"]],
      );
    });

    it("copies into a collection the item was added to, or when asked to fill", async function () {
      const it = item("c4-copy-missing");
      const expected: Operation[] = [
        {
          op: "copy",
          itemKey: it.key,
          attachmentKey: attachmentOf(it).key,
          from: "Physics/Optics/Copy Missing.pdf",
          to: "Physics/Plasma/Copy Missing.pdf",
        },
      ];
      assert.deepEqual((await planFor(it, { addedTo: [collectionID("Physics/Plasma")] })).operations, expected);
      assert.deepEqual((await planFor(it, { fill: [attachmentOf(it).key] })).operations, expected);
    });

    it("leaves a differing copy alone", async function () {
      const plan = await planFor(item("c4-copy-differs"), { fill: [attachmentOf(item("c4-copy-differs")).key] });
      assert.deepEqual(plan.operations, []);
      assert.deepEqual(
        plan.notes.map((n) => [n.kind, n.path]),
        [["copy-differs", "Chemistry/Copy Differs.pdf"]],
      );
    });

    it("points at a surviving copy when Zotero's copy is gone", async function () {
      const it = item("c3-pointed-missing");
      const plan = await planFor(it);
      assert.deepEqual(plan.operations, [
        { op: "relink", itemKey: it.key, attachmentKey: attachmentOf(it).key, to: "Chemistry/Pointed Missing.pdf" },
      ]);
      assert.deepEqual(
        plan.notes.map((n) => [n.kind, n.path]),
        [["copy-missing", "Physics/Optics/Pointed Missing.pdf"]],
      );
    });

    it("only notes missing and misplaced files, and ignores trashed items", async function () {
      assert.deepEqual(
        (await planFor(item("c3-all-missing"))).notes.map((n) => n.kind),
        ["all-missing"],
      );
      const misplaced = await planFor(item("c5-misplaced"), { fill: [attachmentOf(item("c5-misplaced")).key] });
      assert.deepEqual(misplaced.operations, []);
      assert.deepEqual(
        misplaced.notes.map((n) => [n.kind, n.path]),
        [["misplaced", "Physics/Optics/Misplaced.pdf"]],
      );
      assert.deepEqual(await planFor(item("trashed")), { operations: [], notes: [] });
    });
  });

  describe("execute", function () {
    before(function () {
      setPref("dryRun", false);
    });

    const ids = () => ({ itemKey: item("c4-copy-missing").key, attachmentKey: attachmentOf(item("c4-copy-missing")).key });

    it("copies through a temporary file, and treats an identical copy as done", async function () {
      const op: Operation = { op: "copy", ...ids(), from: "Physics/Optics/Copy Missing.pdf", to: "Physics/Plasma/Copy Missing.pdf" };
      const [first] = await execute([op]);
      assert.equal(first.status, "done", first.reason);
      assert.equal(await md5("Physics/Plasma/Copy Missing.pdf"), await md5("Physics/Optics/Copy Missing.pdf"));
      assert.isFalse(await exists(`Physics/Plasma/Copy Missing.pdf${TEMP_SUFFIX}`));
      const [again] = await execute([op]);
      assert.deepEqual([again.status, again.reason], ["unchanged", "identical-copy-exists"]);
    });

    it("never overwrites, and skips what it cannot do", async function () {
      const before = await md5("Chemistry/Copy Differs.pdf");
      const results = await execute([
        { op: "copy", ...ids(), from: "Physics/Optics/Copy Differs.pdf", to: "Chemistry/Copy Differs.pdf" },
        { op: "copy", ...ids(), from: "Physics/Optics/Nowhere.pdf", to: "Chemistry/Nowhere.pdf" },
        { op: "copy", ...ids(), from: "Physics/Optics/Copy Missing.pdf", to: "../Outside.pdf" },
        { op: "copy", ...ids(), from: "Physics/Optics/Copy Missing.pdf", to: ".attanger-plus-trash/X/Copy Missing.pdf" },
      ]);
      assert.deepEqual(
        results.map((r) => [r.status, r.reason]),
        [
          ["skipped", "target-exists-differs"],
          ["skipped", "source-missing"],
          ["skipped", "bad-path-segment"],
          ["skipped", "in-plugin-trash"],
        ],
      );
      assert.equal(await md5("Chemistry/Copy Differs.pdf"), before);
    });

    it("refuses to delete a pointed file or one without an identical copy kept", async function () {
      const results = await execute([
        { op: "delete", ...ids(), path: "Physics/Optics/Copy Missing.pdf", keep: "Physics/Plasma/Copy Missing.pdf" },
        { op: "delete", ...ids(), path: "Chemistry/Copy Differs.pdf", keep: "Physics/Optics/Copy Differs.pdf" },
        { op: "delete", ...ids(), path: "Physics/Plasma/Copy Missing.pdf", keep: "Chemistry/Nowhere.pdf" },
        { op: "delete", ...ids(), path: "Physics/Plasma/Copy Missing.pdf", keep: "Physics/Plasma/Copy Missing.pdf" },
      ]);
      assert.deepEqual(
        results.map((r) => [r.status, r.reason]),
        [
          ["skipped", "pointed-by-attachment"],
          ["skipped", "keep-differs"],
          ["skipped", "keep-missing"],
          ["skipped", "keep-is-target"],
        ],
      );
      assert.isTrue(await exists("Physics/Optics/Copy Missing.pdf"));
      assert.isTrue(await exists("Chemistry/Copy Differs.pdf"));
      assert.isTrue(await exists("Physics/Plasma/Copy Missing.pdf"));
    });

    it("renames copies, but not onto another file or a pointed file", async function () {
      const results = await execute([
        { op: "rename", ...ids(), from: "Physics/Plasma/Copy Missing.pdf", to: "Physics/Plasma/Copy Renamed.pdf" },
        { op: "rename", ...ids(), from: "Physics/Plasma/Copy Renamed.pdf", to: "Physics/Plasma/Thermal A.pdf" },
        { op: "rename", ...ids(), from: "Physics/Optics/Copy Missing.pdf", to: "Physics/Optics/Elsewhere.pdf" },
      ]);
      assert.deepEqual(
        results.map((r) => [r.status, r.reason]),
        [
          ["done", undefined],
          ["skipped", "target-exists"],
          ["skipped", "pointed-by-attachment"],
        ],
      );
      assert.isFalse(await exists("Physics/Plasma/Copy Missing.pdf"));
      assert.isTrue(await exists("Physics/Plasma/Copy Renamed.pdf"));
    });

    it("deletes an identical unpointed copy, even a read-only one", async function () {
      const rel = "Physics/Plasma/Copy Renamed.pdf";
      if (Zotero.isWin) {
        await IOUtils.setWindowsAttributes(abs(rel), { readOnly: true });
      }
      const [result] = await execute([{ op: "delete", ...ids(), path: rel, keep: "Physics/Optics/Copy Missing.pdf" }]);
      assert.equal(result.status, "done", result.reason);
      assert.isFalse(await exists(rel));
      assert.isTrue(await exists("Physics/Optics/Copy Missing.pdf"));
    });

    it("relinks only to an identical file", async function () {
      const missing = item("c3-pointed-missing");
      const differs = item("c4-copy-differs");
      const results = await execute([
        { op: "relink", itemKey: missing.key, attachmentKey: attachmentOf(missing).key, to: "Chemistry/Pointed Missing.pdf" },
        { op: "relink", itemKey: differs.key, attachmentKey: attachmentOf(differs).key, to: "Chemistry/Copy Differs.pdf" },
      ]);
      assert.deepEqual(
        results.map((r) => [r.status, r.reason]),
        [
          ["done", undefined],
          ["skipped", "current-file-differs"],
        ],
      );
      assert.equal(pathKey(attachmentOf(missing).getFilePath() as string), pathKey(abs("Chemistry/Pointed Missing.pdf")));
      assert.equal(pathKey(attachmentOf(differs).getFilePath() as string), pathKey(abs("Physics/Optics/Copy Differs.pdf")));
    });

    it("changes nothing in dry-run mode, but logs every operation", async function () {
      const before = await tree();
      const results = await execute(
        [
          { op: "copy", ...ids(), from: "Physics/Optics/Copy Missing.pdf", to: "Physics/Plasma/Copy Missing.pdf" },
          { op: "delete", ...ids(), path: "Chemistry/Doi A.pdf", keep: "Chemistry/Doi B.pdf" },
          { op: "rename", ...ids(), from: "Chemistry/Doi A.pdf", to: "Chemistry/Doi C.pdf" },
        ],
        { dryRun: true },
      );
      assert.deepEqual(results.map((r) => r.status), ["dry-run", "dry-run", "dry-run"]);
      assert.deepEqual([...(await tree())].sort(), [...before].sort());
      const lines = (await IOUtils.readUTF8(logFileFor(new Date()))).trim().split("\n");
      const last = lines.slice(-3).map((l) => JSON.parse(l));
      assert.deepEqual(
        last.map((r) => [r.op, r.status, r.dryRun]),
        [
          ["copy", "dry-run", true],
          ["delete", "dry-run", true],
          ["rename", "dry-run", true],
        ],
      );
      assert.equal(last[1].path, "Chemistry/Doi A.pdf");
    });
  });

  describe("plan and execute together", function () {
    before(async function () {
      lib = await resetTestLibrary();
      setPref("dryRun", false);
    });

    async function reconcile(it: Zotero.Item, intent?: Intent, state?: AttachmentState) {
      const plan = await planFor(it, intent, state);
      const results = await execute(plan.operations);
      for (const r of results) {
        assert.equal(r.status, "done", `${r.operation.op}: ${r.reason}`);
      }
      return plan;
    }

    it("removing an item from a collection deletes the copy there (F3.2)", async function () {
      const it = item("ok-multi");
      await Zotero.DB.executeTransaction(async () => {
        await (Zotero.Collections.get(collectionID("Chemistry")) as Zotero.Collection).removeItems([it.id]);
      });
      const plan = await reconcile(it, { removedFrom: [collectionID("Chemistry")] });
      assert.deepEqual(plan.operations.map((o) => o.op), ["delete"]);
      assert.isFalse(await exists("Chemistry/Clean Multi Collection Item.pdf"));
      assert.deepEqual(await checkIssuesAbout(it, "Clean Multi Collection Item.pdf"), []);
    });

    it("removing it from the collection Zotero points into relinks first", async function () {
      const it = await makeItem("Sync Pointed Removed", ["Physics/Optics", "Physics/Plasma"], "Physics/Optics", "Pointed Removed.pdf");
      await reconcile(it, { fill: [attachmentOf(it).key] });
      assert.isTrue(await exists("Physics/Plasma/Pointed Removed.pdf"));
      await Zotero.DB.executeTransaction(async () => {
        await (Zotero.Collections.get(collectionID("Physics/Optics")) as Zotero.Collection).removeItems([it.id]);
      });
      const plan = await reconcile(it, { removedFrom: [collectionID("Physics/Optics")] });
      assert.deepEqual(plan.operations.map((o) => o.op), ["relink", "delete"]);
      assert.equal(pathKey(attachmentOf(it).getFilePath() as string), pathKey(abs("Physics/Plasma/Pointed Removed.pdf")));
      assert.isFalse(await exists("Physics/Optics/Pointed Removed.pdf"));
      assert.deepEqual(await checkIssuesAbout(it, "Pointed Removed.pdf"), []);
    });

    it("adding an item to a collection copies its file there (F3.1)", async function () {
      const it = item("ok-single");
      it.addToCollection(collectionID("Chemistry"));
      await it.saveTx();
      await reconcile(it, { addedTo: [collectionID("Chemistry")] });
      assert.equal(await md5("Chemistry/Clean Single Collection Item.pdf"), await md5("Physics/Optics/Clean Single Collection Item.pdf"));
      assert.deepEqual(await checkIssuesAbout(it, "Clean Single Collection Item.pdf"), []);
    });

    it("a file in the root itself moves into the item's collection folder (Q4)", async function () {
      const it = await makeItem("Sync From Root", [], "", "From Root.pdf");
      it.addToCollection(collectionID("Chemistry"));
      await it.saveTx();
      const plan = await reconcile(it);
      assert.deepEqual(plan.operations.map((o) => o.op), ["copy", "relink", "delete"]);
      assert.isFalse(await exists("From Root.pdf"));
      assert.equal(pathKey(attachmentOf(it).getFilePath() as string), pathKey(abs("Chemistry/From Root.pdf")));
      assert.deepEqual(await checkIssuesAbout(it, "From Root.pdf"), []);
    });

    it("copies under the previous name follow a rename (F3.5)", async function () {
      const it = await makeItem("Sync Rename", ["Physics/Optics", "Physics/Plasma"], "Physics/Optics", "Old Name.pdf");
      await reconcile(it, { fill: [attachmentOf(it).key] });
      const state = await AttachmentState.load();
      const att = attachmentOf(it);
      state.set(att.key, { name: "Old Name.pdf", folder: "Physics/Optics", size: 0, mtime: 0, md5: "" });
      assert.isTrue(await att.renameAttachmentFile("New Name.pdf"));
      const plan = await reconcile(it, undefined, state);
      assert.deepEqual(plan.operations, [
        { op: "rename", itemKey: it.key, attachmentKey: att.key, from: "Physics/Plasma/Old Name.pdf", to: "Physics/Plasma/New Name.pdf" },
      ]);
      assert.isFalse(await exists("Physics/Plasma/Old Name.pdf"));
      assert.deepEqual(await checkIssuesAbout(it, "New Name.pdf"), []);
    });
  });

  describe("attachment state", function () {
    beforeEach(async function () {
      await IOUtils.remove(stateFile(), { ignoreAbsent: true });
    });

    it("saves and loads records", async function () {
      const state = await AttachmentState.load();
      assert.deepEqual(state.keys(), []);
      const record = { name: "A.pdf", folder: "Physics", size: 10, mtime: 20, md5: "abc" };
      state.set("KEY1", record);
      await state.save();
      const again = await AttachmentState.load();
      assert.deepEqual(again.get("KEY1"), record);
      again.delete("KEY1");
      assert.isUndefined(again.get("KEY1"));
    });

    it("sets an unreadable file aside and starts empty", async function () {
      await IOUtils.makeDirectory(PathUtils.parent(stateFile())!, { createAncestors: true, ignoreExisting: true });
      await IOUtils.writeUTF8(stateFile(), "{ not json");
      const state = await AttachmentState.load();
      assert.deepEqual(state.keys(), []);
      assert.isFalse(await IOUtils.exists(stateFile()));
      const aside = (await IOUtils.getChildren(PathUtils.parent(stateFile())!)).filter((p) =>
        PathUtils.filename(p).startsWith("state.broken-"),
      );
      assert.isNotEmpty(aside);
    });
  });
});
