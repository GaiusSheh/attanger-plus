import { CHECK_IDS } from "../src/check/types";
import { resetTestLibrary } from "../src/dev/testLibrary";
import { buildMarkdown, closeReports, openReport } from "../src/ui/report";

const assert: Chai.AssertStatic = chai.assert;

describe("report UI", function () {
  this.timeout(120_000);

  before(async function () {
    await resetTestLibrary();
  });

  after(function () {
    closeReports();
  });

  it("adds the check to the Tools menu", async function () {
    const win = Zotero.getMainWindow();
    const menu = win.document.getElementById("toolsMenu") as unknown as { open: boolean };
    const popup = win.document.getElementById("menu_ToolsPopup")!;
    const shown = new Promise((resolve) => popup.addEventListener("popupshown", resolve, { once: true }));
    menu.open = true;
    await shown;
    const item = popup.querySelector('[data-l10n-id="attanger-plus-menu-check"]');
    menu.open = false;
    assert.isNotNull(item);
  });

  it("renders one section per check that found something, with localized text", async function () {
    const win = await openReport();
    const doc = win.document;
    await doc.l10n!.translateRoots();
    const report = await Zotero.AttangerPlus!.check();
    const checksWithIssues = CHECK_IDS.filter((id) => report.issues.some((i) => i.check === id));
    const sections = [...doc.querySelectorAll("#results details")];
    assert.lengthOf(sections, checksWithIssues.length);
    assert.lengthOf(doc.querySelectorAll("#results li"), report.issues.length);
    for (const span of Array.from(doc.querySelectorAll("#results li > span")) as Element[]) {
      assert.notEqual(span.textContent!.trim(), "", span.getAttribute("data-l10n-id") ?? "");
    }
    assert.isTrue(doc.getElementById("config")!.hidden);
  });

  it("exports Markdown with every issue", async function () {
    const win = await openReport();
    const report = await Zotero.AttangerPlus!.check();
    const md = await buildMarkdown(win.document, report);
    const bullets = md.split("\n").filter((line) => line.startsWith("- "));
    assert.lengthOf(bullets, report.issues.length);
    for (const id of CHECK_IDS) {
      assert.equal(md.includes(`## ${id} ·`), report.issues.some((i) => i.check === id), id);
    }
  });

  it("returns plain JSON from the public check() API", async function () {
    const report = await Zotero.AttangerPlus!.check();
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
    assert.isAbove(report.issues.length, 0);
  });
});
