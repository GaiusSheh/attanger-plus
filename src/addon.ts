import hooks from "./hooks";
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
  };

  constructor(rootURI: string) {
    this.rootURI = rootURI;
  }
}
