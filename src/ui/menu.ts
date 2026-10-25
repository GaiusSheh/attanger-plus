import { config } from "../../package.json";
import { l10nID } from "./l10n";
import { openReport } from "./report";
import { currentCollection, hasFiles, showInCollectionFolder } from "./reveal";

const TOOLS_MENU_ID = "attanger-plus-tools-check";
const ITEM_MENU_ID = "attanger-plus-item-reveal";

/** Zotero 8+ MenuManager; menus are also removed automatically when the plugin is disabled. */
export function registerMenus(): void {
  register({
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
  register({
    menuID: ITEM_MENU_ID,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: l10nID("menu-reveal"),
        onShowing: (_event, context) => {
          context.setEnabled(hasFiles(context.items ?? []));
        },
        onCommand: (_event, context) => {
          showInCollectionFolder(context.items ?? [], currentCollection()).catch((e) => Zotero.logError(e));
        },
      },
    ],
  });
}

export function unregisterMenus(): void {
  Zotero.MenuManager.unregisterMenu(TOOLS_MENU_ID);
  Zotero.MenuManager.unregisterMenu(ITEM_MENU_ID);
}

function register(options: Parameters<typeof Zotero.MenuManager.registerMenu>[0]): void {
  if (!Zotero.MenuManager.registerMenu(options)) {
    throw new Error(`Could not register menu ${options.menuID}`);
  }
}
