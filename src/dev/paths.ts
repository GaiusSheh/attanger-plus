import { testDataDir } from "../utils/testDataDir";

/**
 * Locate the test library and refuse to run anywhere else.
 *
 * Every destructive dev helper must call this first. The only accepted data
 * directories are the dev instance (`.../Zotero-dev/data`, see .env) and the
 * scaffold test runner (`.../.scaffold/test/data`); where their files roots
 * are is explained in src/utils/testDataDir.ts.
 */
export function testLibraryPaths(): { dataDir: string; root: string } {
  const test = testDataDir();
  if (!test) {
    throw new Error(
      `Refusing to touch this library: data directory is ${Zotero.DataDirectory.dir}, ` +
        "expected ...\\Zotero-dev\\data or ...\\.scaffold\\test\\data",
    );
  }
  return { dataDir: test.dataDir, root: test.root };
}
