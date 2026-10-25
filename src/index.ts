import { Addon } from "./addon";
import { resetTestLibrary } from "./dev/testLibrary";

// Loaded by addon/bootstrap.js once per plugin startup. A previous instance
// can still be attached if shutdown failed half-way; never stack two.
// The property name must match package.json config.addonInstance.
if (!Zotero.AttangerPlus) {
  const addon = new Addon(rootURI);
  if (__DEV__) {
    addon.dev = { resetTestLibrary };
  }
  Zotero.AttangerPlus = addon;
}
