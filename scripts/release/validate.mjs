import assert from "node:assert/strict";
import { appendFile, lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { distributionFiles } from "../distribution.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export async function validateDistribution({ root = projectRoot, version } = {}) {
  const json = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));
  const manifest = await json("manifest.json");
  const pkg = await json("package.json");
  const versions = await json("versions.json");
  assert(versionPattern.test(manifest.version), "Version must be x.y.z without v.");
  assert.equal(pkg.version, manifest.version, "Package and manifest versions differ.");
  if (version !== undefined)
    assert.equal(manifest.version, version, "The release version differs from the manifest.");
  assert.equal(manifest.id, "lindvimera");
  assert.equal(manifest.isDesktopOnly, true);
  assert.equal(versions[manifest.version], manifest.minAppVersion, "Update versions.json.");
  for (const [entryVersion, minimum] of Object.entries(versions))
    assert(
      versionPattern.test(entryVersion) && versionPattern.test(minimum),
      "Invalid versions entry.",
    );
  const directory = join(root, "dist");
  const actualFiles = [];
  for (const path of await readdir(directory, { recursive: true })) {
    const info = await lstat(join(directory, path));
    assert(!info.isSymbolicLink(), "Distribution cannot contain symbolic links.");
    if (info.isFile()) {
      assert(info.size > 0, `Empty distribution file: ${path}`);
      actualFiles.push(path.replaceAll("\\", "/"));
    }
  }
  assert.deepEqual(
    actualFiles.sort(),
    [...distributionFiles].sort(),
    "Distribution inventory differs.",
  );
  for (const file of ["manifest.json", "styles.css"])
    assert.deepEqual(
      await readFile(join(directory, file)),
      await readFile(join(root, file)),
      `Stale ${file}`,
    );
  const bundle = await readFile(join(directory, "main.js"), "utf8");
  assert(
    !/^\s*\/\/[#@]\s*sourceMappingURL=/m.test(bundle),
    "Development source maps cannot be released.",
  );
  return manifest.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = await validateDistribution({ version: process.env.RELEASE_VERSION });
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(`Validated release distribution ${version}.`);
}
