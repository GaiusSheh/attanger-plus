import { Addon } from "./addon";
import { resetTestLibrary } from "./dev/testLibrary";
import { log } from "./utils/log";

// Loaded by addon/bootstrap.js once per plugin startup. The property name
// must match package.json config.addonInstance.
//
// An instance can still be attached if an earlier shutdown failed half-way
// (seen when upgrading 0.1.0 -> 0.2.0, known_pits A11). Keeping it would
// make bootstrap start the stale code, so stop its event handling and
// replace it. Its own shutdown is not called: it would delete the new one.
const stale = Zotero.AttangerPlus;
if (stale) {
  try {
    stale.sync?.stop().catch(() => {});
  } catch (e) {
    // A stale instance from unloaded code can throw on any access.
    log(`stale instance could not be stopped: ${String(e)}`);
  }
  log("replacing an instance left by an incomplete shutdown");
}
const addon = new Addon(rootURI);
if (__DEV__) {
  addon.dev = { resetTestLibrary };
}
Zotero.AttangerPlus = addon;
