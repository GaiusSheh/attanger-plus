/* global Components, Services, Zotero, APP_SHUTDOWN */

// Zotero 7+ bootstrapped-plugin entry points. The actual plugin lives in the
// bundled script content/scripts/__addonRef__.js, which this file loads.

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, rootURI }, reason) {
  await Zotero.initializationPromise;

  // chrome://__addonRef__/content/ for dialogs added later.
  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = aomStartup.registerChrome(
    Services.io.newURI(rootURI + "manifest.json"),
    [["content", "__addonRef__", rootURI + "content/"]],
  );

  // The bundled script sees `rootURI` as a free variable through this scope.
  const scope = { rootURI };
  Services.scriptloader.loadSubScript(
    `${rootURI}content/scripts/__addonRef__.js`,
    scope,
  );
  await Zotero.__addonInstance__.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }
  await Zotero.__addonInstance__?.hooks.onShutdown();
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
