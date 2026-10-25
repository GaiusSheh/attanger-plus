/**
 * Locate the test library and refuse to run anywhere else.
 *
 * Every destructive dev helper must call this first. The only accepted data
 * directories are the dev instance (`.../Zotero-dev/data`, see .env) and the
 * scaffold test runner (`.../.scaffold/test/data`).
 *
 * Files root: the dev instance uses the sibling `literature` folder. The test
 * runner's directory is fixed by scaffold inside the project, i.e. inside
 * OneDrive, whose read-only folder attributes make it impossible to delete
 * (known_pits B1), so its root goes to the system temp directory instead.
 */
export function testLibraryPaths(): { dataDir: string; root: string } {
  const dataDir = Zotero.DataDirectory.dir;
  const parent = PathUtils.parent(dataDir);
  const grandparent = parent ? PathUtils.parent(parent) : null;
  const isDev = !!parent && PathUtils.filename(parent) === "Zotero-dev";
  const isTest =
    !!parent &&
    !!grandparent &&
    PathUtils.filename(parent) === "test" &&
    PathUtils.filename(grandparent) === ".scaffold";
  if (PathUtils.filename(dataDir) !== "data" || !(isDev || isTest)) {
    throw new Error(
      `Refusing to touch this library: data directory is ${dataDir}, ` +
        "expected ...\\Zotero-dev\\data or ...\\.scaffold\\test\\data",
    );
  }
  const root = isDev
    ? PathUtils.join(parent!, "literature")
    : PathUtils.join(PathUtils.tempDir, "attanger-plus-test", "literature");
  return { dataDir, root };
}
