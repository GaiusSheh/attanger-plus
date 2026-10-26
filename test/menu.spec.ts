import { registerMenus, unregisterMenus } from "../src/ui/menu";

const assert: Chai.AssertStatic = chai.assert;

/*
 * Menu registration across instances (known_pits A11). This test bundle
 * imports its own copy of src/ui/menu.ts, so to it the running plugin's
 * registration is one "left by another instance" — the situation of a new
 * version starting while the old one's cleanup did not run.
 */
describe("menu registration", function () {
  this.timeout(60_000);

  /** Whether the Tools menu shows the check entry (MenuManager inserts it on showing). */
  async function toolsEntryShown(): Promise<boolean> {
    const win = Zotero.getMainWindow();
    const menu = win.document.getElementById("toolsMenu") as unknown as { open: boolean };
    const popup = win.document.getElementById("menu_ToolsPopup")!;
    const shown = new Promise((resolve) => popup.addEventListener("popupshown", resolve, { once: true }));
    menu.open = true;
    await shown;
    const item = popup.querySelector('[data-l10n-id="attanger-plus-menu-check"]');
    menu.open = false;
    return !!item;
  }

  after(function () {
    // Leave the menus registered for the other tests.
    registerMenus();
  });

  it("removes a registration it did not make itself, by Zotero's key", async function () {
    assert.isTrue(await toolsEntryShown(), "the running plugin registered it");
    unregisterMenus();
    assert.isFalse(await toolsEntryShown());
  });

  it("registers, and registers again over its own leftover without throwing", async function () {
    registerMenus();
    assert.isTrue(await toolsEntryShown());
    assert.doesNotThrow(() => registerMenus());
    assert.isTrue(await toolsEntryShown());
  });

  it("unregisters twice without throwing", async function () {
    unregisterMenus();
    assert.doesNotThrow(() => unregisterMenus());
    assert.isFalse(await toolsEntryShown());
  });
});
