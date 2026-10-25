import { Addon } from "./addon";

// Loaded by addon/bootstrap.js once per plugin startup. A previous instance
// can still be attached if shutdown failed half-way; never stack two.
// The property name must match package.json config.addonInstance.
if (!Zotero.AttangerPlus) {
  Zotero.AttangerPlus = new Addon(rootURI);
}
