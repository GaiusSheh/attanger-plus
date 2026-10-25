import hooks from "./hooks";
import type { runCheck } from "./check";
import type { resetTestLibrary } from "./dev/testLibrary";

export class Addon {
  readonly rootURI: string;
  readonly data = {
    initialized: false,
  };
  readonly hooks = hooks;
  /** Development builds only (`npm start`); absent from release builds. */
  dev?: {
    resetTestLibrary: typeof resetTestLibrary;
    /** Until the public check() API lands (Phase 1-4). */
    runCheck: typeof runCheck;
  };

  constructor(rootURI: string) {
    this.rootURI = rootURI;
  }
}
