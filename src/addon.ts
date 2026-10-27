import { runCheck, type CheckReport } from "./check";
import type { resetTestLibrary } from "./dev/testLibrary";
import hooks from "./hooks";
import { SyncQueue } from "./sync/queue";
import { initPrefsPane } from "./ui/prefs";

export class Addon {
  readonly rootURI: string;
  readonly data = {
    initialized: false,
  };
  readonly hooks = hooks;
  /**
   * Copy maintenance (requirements §F3): reacts to Zotero events. flush(),
   * pause() and resume() are for tests and agents.
   */
  readonly sync = new SyncQueue();
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

  /** Fills in the settings pane once Zotero has loaded it (addon/content/preferences.xhtml). */
  onPrefsLoad(doc: Document): void {
    try {
      initPrefsPane(doc);
    } catch (e) {
      Zotero.logError(e as Error);
    }
  }
}
