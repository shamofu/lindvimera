import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { distributionFiles } from "../../scripts/distribution.mjs";
import {
  distributionAssetSources,
  legacyLinderaFiles,
  linderaRuntimeFiles,
} from "../../scripts/lindera-assets.mjs";
import { validateDistribution } from "../../scripts/release/validate.mjs";

const version = "0.2.0";

async function createDistributionFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lindvimera-distribution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { id: "lindvimera", version, minAppVersion: "1.15.0", isDesktopOnly: true };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(join(root, "versions.json"), JSON.stringify({ [version]: "1.15.0" }));
  await writeFile(join(root, "styles.css"), ".lindvimera { color: inherit; }\n");
  for (const file of distributionFiles) {
    const path = join(root, "dist", file);
    await mkdir(dirname(path), { recursive: true });
    const content = ["manifest.json", "styles.css"].includes(file)
      ? await readFile(join(root, file))
      : file === "main.js"
        ? "module.exports = {};\n"
        : `Retained distribution file: ${file}\n`;
    await writeFile(path, content);
  }
  return root;
}

test("distributes surface-only dictionary assets while retaining legacy detail cleanup", () => {
  const names = [
    "metadata.json",
    "dict.trie",
    "dict.valsidx",
    "dict.vals",
    "dict.wordsidx",
    "dict.words",
    "matrix.mtx",
    "char_def.bin",
    "unk.bin",
  ];
  const runtimeNames = names.filter((name) => name !== "dict.words" && name !== "dict.wordsidx");
  const sources = distributionAssetSources({
    wasmPath: "wasm-source",
    dictionaryPaths: names.map((name) => `cache/${name}`),
    licensePath: "license-source",
    noticePath: "notice-source",
  });
  assert.deepEqual(
    [...sources],
    [
      ["lindera/lindera_wasm_bg.wasm", "wasm-source"],
      ...runtimeNames.map((name) => [`lindera/ipadic/${name}`, `cache/${name}`]),
      ["lindera/LICENSE", "license-source"],
      ["lindera/ipadic/NOTICE.txt", "notice-source"],
    ],
  );
  assert.deepEqual(linderaRuntimeFiles, [
    "lindera/lindera_wasm_bg.wasm",
    ...runtimeNames.map((name) => `lindera/ipadic/${name}`),
  ]);
  assert.deepEqual(
    [...legacyLinderaFiles].sort(),
    ["lindera/lindera_wasm_bg.wasm", ...names.map((name) => `lindera/ipadic/${name}`)].sort(),
  );
});

test("validates distribution inventory and version consistency", async (t) => {
  const root = await createDistributionFixture(t);
  assert.equal(await validateDistribution({ root, version }), version);
  await assert.rejects(validateDistribution({ root, version: "0.3.0" }), /release version differs/);

  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  await assert.rejects(validateDistribution({ root }), /Package and manifest versions differ/);
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));

  await writeFile(join(root, "versions.json"), JSON.stringify({ [version]: "1.12.0" }));
  await assert.rejects(validateDistribution({ root }), /Update versions\.json/);
  await writeFile(join(root, "versions.json"), JSON.stringify({ [version]: "1.15.0" }));

  await writeFile(
    join(root, "dist", "main.js"),
    "module.exports = {};\n//# sourceMappingURL=data:application/json;base64,e30=",
  );
  await assert.rejects(validateDistribution({ root }), /Development source maps/);

  await rm(join(root, "dist", "LICENSE"));
  await assert.rejects(validateDistribution({ root }), /inventory differs/);
});
