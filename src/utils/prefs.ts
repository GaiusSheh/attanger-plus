import { config } from "../../package.json";

/*
 * The plugin's own preferences; defaults live in addon/prefs.js (scaffold
 * adds the prefix there).
 */

function prefName(name: string): string {
  return `${config.prefsPrefix}.${name}`;
}

export function getPref(name: string): unknown {
  return Zotero.Prefs.get(prefName(name), true);
}

export function setPref(name: string, value: string | number | boolean): void {
  Zotero.Prefs.set(prefName(name), value, true);
}

/** Watch one of the plugin's preferences; returns the handle for unwatchPref(). */
export function watchPref(name: string, handler: () => void): symbol {
  return Zotero.Prefs.registerObserver(prefName(name), handler, true);
}

export function unwatchPref(handle: symbol): void {
  Zotero.Prefs.unregisterObserver(handle);
}

/**
 * Copy maintenance switched on (requirements §F7). Off, Zotero's events are
 * left alone; the check, locating files and the user's explicit repairs stay.
 */
export function isMaintaining(): boolean {
  return getPref("maintainCopies") !== false;
}

/**
 * Dry-run mode: plan and log write operations without carrying them out.
 * Anything but an explicit `false` counts as on, so a missing default never
 * lets writes through.
 */
export function isDryRun(): boolean {
  return getPref("dryRun") !== false;
}
