import { config } from "../../package.json";
import { l10nID } from "./l10n";
import { openReport } from "./report";

const TOOLS_MENU_ID = "attanger-plus-tools-check";

/** Zotero 8+ MenuManager; menus are also removed automatically when the plugin is disabled. */
export function registerMenus(): void {
  const registered = Zotero.MenuManager.registerMenu({
    menuID: TOOLS_MENU_ID,
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: l10nID("menu-check"),
        onCommand: () => {
          openReport().catch((e) => Zotero.logError(e));
        },
      },
    ],
  });
  if (!registered) {
    throw new Error(`Could not register menu ${TOOLS_MENU_ID}`);
  }
}

export function unregisterMenus(): void {
  Zotero.MenuManager.unregisterMenu(TOOLS_MENU_ID);
}
