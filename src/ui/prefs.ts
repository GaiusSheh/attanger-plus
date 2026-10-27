import type { FluentMessageId } from "../../typings/i10n";
import { config } from "../../package.json";
import { attangerNotices } from "../check";
import { logFileFor, pluginDataDir } from "../sync/log";
import { l10nID } from "./l10n";

/*
 * The settings pane (requirements §F7). Its switches are bound to the
 * plugin's preferences by Zotero itself (`preference` attributes in
 * preferences.xhtml); this fills in what is shown read-only and wires the
 * button to open the operation log.
 */

/** Zotero drops the pane by itself when the plugin shuts down. */
export async function registerPrefsPane(): Promise<void> {
  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: `${rootURI}content/preferences.xhtml`,
    label: config.addonName,
  });
}

/** Called by the pane's `load` event, in Zotero's settings window. */
export function initPrefsPane(doc: Document): void {
  const element = (id: string) => {
    const el = doc.getElementById(`attanger-plus-prefs-${id}`);
    if (!el) {
      throw new Error(`preferences.xhtml has no #attanger-plus-prefs-${id}`);
    }
    return el;
  };
  const localize = (el: Element, id: FluentMessageId, args?: Record<string, string>) =>
    doc.l10n!.setAttributes(el, l10nID(id), args);

  const root = (Zotero.Prefs.get("baseAttachmentPath") as string | undefined) || null;
  localize(element("root"), root ? "prefs-root" : "prefs-root-unset", root ? { root } : undefined);
  const notices = element("notices");
  notices.replaceChildren(
    ...attangerNotices(root).map((notice) => {
      const li = doc.createElementNS("http://www.w3.org/1999/xhtml", "li");
      localize(li, `config-${notice.kind}` as FluentMessageId, { detail: notice.detail });
      return li;
    }),
  );

  localize(element("log-path"), "prefs-log-path", { folder: pluginDataDir() });
  element("open-log").addEventListener("command", () => {
    openLog().catch((e) => Zotero.logError(e));
  });
}

/** This month's operation log in the system's program for it; its folder while there is none yet. */
export async function openLog(now = new Date()): Promise<string> {
  const file = logFileFor(now);
  if (await IOUtils.exists(file)) {
    Zotero.launchFile(file);
    return file;
  }
  const folder = pluginDataDir();
  await IOUtils.makeDirectory(folder, { createAncestors: true, ignoreExisting: true });
  Zotero.launchFile(folder);
  return folder;
}
