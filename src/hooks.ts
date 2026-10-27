import { config, version } from "../package.json";
import { l10nID } from "./ui/l10n";
import { registerMenus, unregisterMenus } from "./ui/menu";
import { closeChangesWindows, showChanges } from "./ui/changes";
import { closeRemoveDialogs } from "./ui/remove";
import { closeReports } from "./ui/report";
import { closeToast, showSummary } from "./ui/toast";
import { closeUnfiledWindows, showUnfiled } from "./ui/unfiled";
import { log } from "./utils/log";

// scaffold prefixes FTL file names with the plugin namespace.
const MAIN_WINDOW_FTL = "attanger-plus-mainWindow.ftl";

async function onStartup(): Promise<void> {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  // Windows that were already open when the plugin was (re)installed never
  // receive onMainWindowLoad.
  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)));
  // Menus are not worth failing the start for: copy maintenance must run.
  await safely("startup: menus", registerMenus);
  addon().sync.onFindings = (findings) => {
    showChanges(findings).catch((e) => Zotero.logError(e));
  };
  addon().sync.onUnfiled = (items) => {
    showUnfiled(items).catch((e) => Zotero.logError(e));
  };
  addon().sync.onApplied = (summary) => {
    showSummary(summary).catch((e) => Zotero.logError(e));
  };
  addon().sync.start();

  addon().data.initialized = true;
  log(`startup done (${version})`);
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(MAIN_WINDOW_FTL);
  const l10n = new win.Localization([MAIN_WINDOW_FTL]);
  const msg = await l10n.formatValue(l10nID("startup-loaded"), {
    name: config.addonName,
    version,
  });
  log(`main window ready: ${msg}`);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  win.document.querySelector(`link[href="${MAIN_WINDOW_FTL}"]`)?.remove();
}

/**
 * Every step on its own: one that fails must not keep the instance attached,
 * or it would linger after an upgrade or uninstall (known_pits A11).
 */
async function onShutdown(): Promise<void> {
  await safely("shutdown: copy maintenance", () => addon().sync.stop());
  await safely("shutdown: menus", unregisterMenus);
  await safely("shutdown: windows", () => {
    closeReports();
    closeRemoveDialogs();
    closeChangesWindows();
    closeUnfiledWindows();
    closeToast();
  });
  for (const win of Zotero.getMainWindows()) {
    await safely("shutdown: main window", () => onMainWindowUnload(win));
  }
  if (Zotero.AttangerPlus) {
    Zotero.AttangerPlus.data.initialized = false;
  }
  delete Zotero.AttangerPlus;
  log("shutdown");
}

async function safely(step: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    Zotero.logError(e as Error);
    log(`${step} failed: ${String(e)}`);
  }
}

function addon() {
  if (!Zotero.AttangerPlus) {
    throw new Error("Zotero.AttangerPlus is not attached");
  }
  return Zotero.AttangerPlus;
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
};
