import { config, version } from "../package.json";
import { l10nID } from "./ui/l10n";
import { registerMenus, unregisterMenus } from "./ui/menu";
import { closeChangesWindows, showChanges } from "./ui/changes";
import { closeRemoveDialogs } from "./ui/remove";
import { closeReports } from "./ui/report";
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
  registerMenus();
  addon().sync.onFindings = (findings) => {
    showChanges(findings).catch((e) => Zotero.logError(e));
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

async function onShutdown(): Promise<void> {
  await addon().sync.stop();
  unregisterMenus();
  closeReports();
  closeRemoveDialogs();
  closeChangesWindows();
  for (const win of Zotero.getMainWindows()) {
    await onMainWindowUnload(win);
  }
  addon().data.initialized = false;
  delete Zotero.AttangerPlus;
  log("shutdown");
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
