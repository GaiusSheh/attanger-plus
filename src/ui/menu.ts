import { config } from "../../package.json";
import { isMaintaining } from "../utils/prefs";
import { l10nID } from "./l10n";
import { canRemoveFromAny, canRemoveFromCurrent, removeFromAll, removeFromChosen, removeFromCurrent } from "./remove";
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
      // Not a submenu: item-menu submenus are broken before Zotero 9.0.1. No
      // separator either: Zotero groups plugin entries under its own and
      // rejects top-level separators here (known_pits A11). The removals
      // promise to take care of the copies: only while copy maintenance is on.
      {
        menuType: "menuitem",
        l10nID: l10nID("menu-remove-current"),
        onShowing: (_event, context) => {
          context.setEnabled(isMaintaining() && canRemoveFromCurrent(context.items ?? [], currentCollection()));
        },
        onCommand: (_event, context) => {
          removeFromCurrent(context.items ?? [], currentCollection()).catch((e) => Zotero.logError(e));
        },
      },
      {
        menuType: "menuitem",
        l10nID: l10nID("menu-remove-all"),
        onShowing: (_event, context) => {
          context.setEnabled(isMaintaining() && canRemoveFromAny(context.items ?? []));
        },
        onCommand: (_event, context) => {
          removeFromAll(context.items ?? []).catch((e) => Zotero.logError(e));
        },
      },
      {
        menuType: "menuitem",
        l10nID: l10nID("menu-remove-chosen"),
        onShowing: (_event, context) => {
          context.setEnabled(isMaintaining() && canRemoveFromAny(context.items ?? []));
        },
        onCommand: (_event, context) => {
          removeFromChosen(context.items ?? [], currentCollection()).catch((e) => Zotero.logError(e));
        },
      },
    ],
  });
}

/**
 * Zotero usually drops a plugin's menus itself when the plugin shuts down;
 * removing them again then only logs a warning and returns false.
 */
export function unregisterMenus(): void {
  for (const menuID of [TOOLS_MENU_ID, ITEM_MENU_ID]) {
    Zotero.MenuManager.unregisterMenu(registered.get(menuID) ?? menuKey(menuID));
  }
  registered.clear();
}

/** Keys MenuManager returned for our menus, which is what unregistering takes. */
const registered = new Map<string, string>();

/**
 * A registration left by an earlier instance whose cleanup did not run
 * (e.g. during an upgrade) makes the new one fail as a duplicate: remove it
 * and try once more. A menu that still cannot be registered is logged, not
 * thrown: the rest of the plugin must start anyway (known_pits A11).
 */
function register(options: Parameters<typeof Zotero.MenuManager.registerMenu>[0]): void {
  let key = Zotero.MenuManager.registerMenu(options);
  if (!key) {
    Zotero.MenuManager.unregisterMenu(menuKey(options.menuID));
    key = Zotero.MenuManager.registerMenu(options);
  }
  if (!key) {
    Zotero.logError(new Error(`Attanger Plus could not register menu ${options.menuID}`));
    return;
  }
  registered.set(options.menuID, key);
}

/** How MenuManager files a menu: CSS-escaped "<pluginID>-<menuID>" (Zotero's pluginAPIBase.mjs). */
function menuKey(menuID: string): string {
  return Zotero.getMainWindow().CSS.escape(`${config.addonID}-${menuID}`);
}
