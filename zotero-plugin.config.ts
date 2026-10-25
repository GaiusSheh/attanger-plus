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
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${addonRef}.js`,
      },
    ],
  },

  server: {
    hooks: {
      "serve:init": assertIsolatedDevEnv,
    },
  },

  test: {
    waitForPlugin: `() => Zotero.${addonInstance}?.data.initialized`,
  },
});
