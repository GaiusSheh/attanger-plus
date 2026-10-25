import { runCheck, type CheckReport } from "./check";
import type { resetTestLibrary } from "./dev/testLibrary";
import hooks from "./hooks";

export class Addon {
  readonly rootURI: string;
  readonly data = {
    initialized: false,
  };
  readonly hooks = hooks;
  /** Development builds only (`npm start`); absent from release builds. */
  dev?: {
    resetTestLibrary: typeof resetTestLibrary;
  };

  constructor(rootURI: string) {
    this.rootURI = rootURI;
  }

  /**
   * Compare the library with the files root (requirements §F1.4). Read-only;
   * the result is plain JSON, e.g. for agents calling through zotero-js-bridge.
   */
  check(): Promise<CheckReport> {
    return runCheck();
  }
}
