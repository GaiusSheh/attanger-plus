import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json" with { type: "json" };

const { addonName, addonID, addonRef, addonInstance, prefsPrefix } = pkg.config;

// Refuse to start the dev server unless it is pointed at a separate profile
// and data directory. Without --dataDir, Zotero falls back to ~/Zotero, i.e.
// the real library.
function assertIsolatedDevEnv(): void {
  const profile = process.env.ZOTERO_PLUGIN_PROFILE_PATH;
  const dataDir = process.env.ZOTERO_PLUGIN_DATA_DIR;
  if (!profile || !dataDir) {
    throw new Error(
      "ZOTERO_PLUGIN_PROFILE_PATH and ZOTERO_PLUGIN_DATA_DIR must both be set in .env " +
        `(got profile=${profile ?? "<unset>"}, dataDir=${dataDir ?? "<unset>"}); see .env.example.`,
    );
  }
  const realDataDir = resolve(homedir(), "Zotero").toLowerCase();
  if (resolve(dataDir).toLowerCase() === realDataDir) {
    throw new Error(`ZOTERO_PLUGIN_DATA_DIR points at the real Zotero data directory: ${dataDir}`);
  }
}

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: addonName,
  id: addonID,
  namespace: "attanger-plus",
  xpiName: "attanger-plus",
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink: "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      addonName,
      addonID,
      addonRef,
      addonInstance,
      buildVersion: pkg.version,
    },
    prefs: {
      prefix: prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        bundle: true,
        // Drops `if (__DEV__)` branches, and with them the dev-only modules.
        minifySyntax: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${addonRef}.js`,
      },
    ],
    hooks: {
      // NODE_ENV is only known once scaffold has picked the command
      // (build: production, serve: development, test: test).
      "build:init": (ctx) => {
        for (const options of ctx.build.esbuildOptions) {
          options.define = {
            ...options.define,
            __DEV__: JSON.stringify(process.env.NODE_ENV !== "production"),
          };
        }
      },
    },
  },

  server: {
    prefs: {
      // Keep clear of the real Zotero (23119); .dev/tools/zotero/zjs.py --dev uses this port.
      "extensions.zotero.httpServer.port": 23124,
    },
    hooks: {
      "serve:init": assertIsolatedDevEnv,
    },
  },

  test: {
    waitForPlugin: `() => Zotero.${addonInstance}?.data.initialized`,
    prefs: {
      // The runner's data dir (.scaffold/test/data) is fixed by scaffold and
      // lies inside OneDrive; without this a modal warning blocks the run.
      "extensions.zotero.warnOnUnsafeDataDir": false,
      // The test library's fixtures are file-manager changes on purpose; the
      // startup scan must not act on them or open its window mid-run.
      [`${prefsPrefix}.inspectOnStartup`]: false,
    },
    hooks: {
      // scaffold has no local source for chai and would otherwise download an
      // unpinned https://www.chaijs.com/chai.js; seed its cache from the
      // pinned npm package instead (mocha is taken from node_modules).
      "test:init": () => {
        mkdirSync(".scaffold/cache", { recursive: true });
        copyFileSync("node_modules/chai/chai.js", ".scaffold/cache/chai.js");
      },
    },
  },
});
