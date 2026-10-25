import type { Addon } from "../src/addon";

declare global {
  /** Provided by addon/bootstrap.js through the subscript scope. */
  const rootURI: string;

  // zotero-types declares Zotero as a namespace, so extend it by merging.
  namespace Zotero {
    let AttangerPlus: Addon | undefined;
  }
}

export {};
