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

/**
 * Dry-run mode: plan and log write operations without carrying them out.
 * Anything but an explicit `false` counts as on, so a missing default never
 * lets writes through.
 */
export function isDryRun(): boolean {
  return getPref("dryRun") !== false;
}
