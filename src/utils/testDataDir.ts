/**
 * Recognize the data directories of the development instance
 * (`.../Zotero-dev/data`, see .env) and of the scaffold test runner
 * (`.../.scaffold/test/data`); null for any other, e.g. the real library.
 *
 * Files root of their test library: the dev instance uses the sibling
 * `literature` folder. The test runner's directory is fixed by scaffold
 * inside the project, i.e. inside OneDrive, whose read-only folder attributes
 * make it impossible to delete (known_pits B1), so its root goes to the
 * system temp directory instead.
 *
 * Not development-only: release builds use it too, to refuse writing outside
 * the test library when installed in a development profile.
 */
export function testDataDir(): { kind: "dev" | "test"; dataDir: string; root: string } | null {
  const dataDir = Zotero.DataDirectory.dir;
  const parent = PathUtils.parent(dataDir);
  const grandparent = parent ? PathUtils.parent(parent) : null;
  if (PathUtils.filename(dataDir) !== "data" || !parent) {
    return null;
  }
  if (PathUtils.filename(parent) === "Zotero-dev") {
    return { kind: "dev", dataDir, root: PathUtils.join(parent, "literature") };
  }
  if (PathUtils.filename(parent) === "test" && grandparent && PathUtils.filename(grandparent) === ".scaffold") {
    return { kind: "test", dataDir, root: PathUtils.join(PathUtils.tempDir, "attanger-plus-test", "literature") };
  }
  return null;
}
