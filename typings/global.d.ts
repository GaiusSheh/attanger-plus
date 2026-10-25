import type { Addon } from "../src/addon";

declare global {
  /** Provided by addon/bootstrap.js through the subscript scope. */
  const rootURI: string;

  /** esbuild define: true unless NODE_ENV is "production" (zotero-plugin.config.ts). */
  const __DEV__: boolean;

  // zotero-types declares Zotero as a namespace, so extend it by merging.
  namespace Zotero {
    let AttangerPlus: Addon | undefined;
  }
}

export {};
