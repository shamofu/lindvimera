import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRemovalFixture } from "../../scripts/engines/fixture.mjs";
import { availableEngines, vimAliases } from "../../scripts/engines/build.mjs";
import { assertEngineBoundary } from "../../scripts/build-boundaries.mjs";

const managerLock =
  "---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    packageManagerDependencies:\n      pnpm:\n        specifier: 12.10.1\n        version: 12.10.1\n";
const applicationLock = `---
lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@codemirror/commands':
        specifier: 6.11.1
        version: 6.11.1
      '@codemirror/search':
        specifier: 6.7.2
        version: 6.7.2
packages:
  '@codemirror/commands@6.11.1':
    resolution: {integrity: shared}
  '@codemirror/search@6.7.2':
    resolution: {integrity: owned}
snapshots:
  '@codemirror/commands@6.11.1':
    dependencies:
      '@codemirror/view': 6.43.13
  '@codemirror/search@6.7.2':
    dependencies:
      '@codemirror/view': 6.43.13
`;

function dependencySource(lock = managerLock + applicationLock) {
  const sourceRoot = mkdtempSync(join(tmpdir(), "lindvimera-dependency-selftest-"));
  const manifest = JSON.stringify({
    devDependencies: { "@codemirror/search": "6.7.2", "@codemirror/commands": "6.11.1" },
  });
  const files = {
    "src/engines/embedded/index.ts": "export {};",
    "src/engines/builtin/index.ts": "export {};",
    "src/engines/registry.ts": "export {};",
    "tsconfig.json": '{"compilerOptions":{"paths":{}}}',
    "package.json": manifest,
    "pnpm-lock.yaml": lock,
    "node_modules/.pnpm/@codemirror+search@6.7.2/node_modules/@codemirror/search/package.json":
      '{"name":"@codemirror/search"}',
    "node_modules/.pnpm/@codemirror+commands@6.11.1/node_modules/@codemirror/commands/package.json":
      '{"name":"@codemirror/commands"}',
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(sourceRoot, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  for (const [name, version] of [
    ["search", "6.7.2"],
    ["commands", "6.11.1"],
  ]) {
    const target = join(
      sourceRoot,
      `node_modules/.pnpm/@codemirror+${name}@${version}/node_modules/@codemirror/${name}`,
    );
    for (const parent of [
      "node_modules/@codemirror",
      "node_modules/.pnpm/node_modules/@codemirror",
    ]) {
      mkdirSync(join(sourceRoot, parent), { recursive: true });
      symlinkSync(
        target,
        join(sourceRoot, parent, name),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  }
  return { sourceRoot, manifest, lock };
}

test("builtin fixture prunes owned manifest/lock dependencies and copied package contents only", () => {
  const source = dependencySource();
  const target = createRemovalFixture({
    sourceRoot: source.sourceRoot,
    survivor: "builtin",
    copyDependencies: true,
  });
  const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  assert.deepEqual(manifest.devDependencies, { "@codemirror/commands": "6.11.1" });
  const lock = readFileSync(join(target, "pnpm-lock.yaml"), "utf8");
  assert.ok(lock.startsWith(managerLock));
  assert.doesNotMatch(lock, /@codemirror\/search/);
  assert.match(lock, /'@codemirror\/commands@6\.11\.1'/);
  for (const path of [
    "node_modules/@codemirror/search",
    "node_modules/.pnpm/@codemirror+search@6.7.2",
    "node_modules/.pnpm/node_modules/@codemirror/search",
  ])
    assert.equal(existsSync(join(target, path)), false, path);
  assert.equal(existsSync(join(target, "node_modules/@codemirror/commands/package.json")), true);
  assert.equal(
    existsSync(join(target, "node_modules/.pnpm/node_modules/@codemirror/commands/package.json")),
    true,
  );
  assert.equal(readFileSync(join(source.sourceRoot, "package.json"), "utf8"), source.manifest);
  assert.equal(readFileSync(join(source.sourceRoot, "pnpm-lock.yaml"), "utf8"), source.lock);
});

test("embedded fixture keeps its owned dependency and both original lock documents", () => {
  const source = dependencySource();
  const target = createRemovalFixture({ sourceRoot: source.sourceRoot, survivor: "embedded" });
  assert.equal(readFileSync(join(target, "package.json"), "utf8"), source.manifest);
  assert.equal(readFileSync(join(target, "pnpm-lock.yaml"), "utf8"), source.lock);
});

test("dependency pruning rejects an owned dependency referenced by a surviving package", () => {
  const source = dependencySource(
    managerLock +
      applicationLock.replace("'@codemirror/view': 6.43.13", "'@codemirror/search': 6.7.2"),
  );
  assert.throws(
    () => createRemovalFixture({ sourceRoot: source.sourceRoot, survivor: "builtin" }),
    /surviving|reference/i,
  );
});

test("removal fixtures physically omit opposite backend, infrastructure and tests", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "lindvimera-removal-selftest-"));
  const files = {
    "src/engines/embedded/index.ts": "export const realEmbedded = true;",
    "src/engines/builtin/index.ts": "export const realBuiltin = true;",
    "src/engines/builtin/policy.ts": "export const analyseKeyBindings = () => ({});",
    "src/engines/registry.ts": "unused before rewrite",
    "src/runtime/editor.ts": "embedded only",
    "test/runtime/editor.test.ts": "embedded test",
    "test/settings.test.ts": "shared test",
    "scripts/prepare-vendor.mjs": "embedded build hook",
    "patches/series.json": "{}",
    "tsconfig.vendor.json": "{}",
    "tsconfig.vendor-core.json": "{}",
    "tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "@replit/codemirror-vim": ["vendor"] } },
    }),
    "package.json": JSON.stringify({ scripts: { build: "node esbuild.config.mjs" } }),
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(sourceRoot, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  const target = createRemovalFixture({ sourceRoot, survivor: "builtin" });
  for (const path of [
    "src/engines/embedded",
    "src/runtime",
    "test/runtime",
    "scripts/prepare-vendor.mjs",
    "patches",
    "tsconfig.vendor.json",
  ])
    assert.equal(existsSync(join(target, path)), false, path);
  assert.equal(existsSync(join(target, "src/engines/builtin/index.ts")), true);
  assert.equal(existsSync(join(target, "test/settings.test.ts")), true);
  assert.deepEqual(availableEngines(target), ["builtin"]);
  assert.match(
    JSON.parse(readFileSync(join(target, "engine-removal.json"))).sourceHash,
    /^[a-f0-9]{64}$/u,
  );
  assert.deepEqual(vimAliases(target), {});
  assert.doesNotMatch(readFileSync(join(target, "src/engines/registry.ts"), "utf8"), /embedded/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(target, "tsconfig.json"))).compilerOptions.paths,
    {},
  );
  assert.throws(
    () => createRemovalFixture({ sourceRoot, survivor: "builtin", outputRoot: sourceRoot }),
    /inside/,
  );
});

test("builtin removal fixture omits embedded probe and owned files while retaining builtin and shared files", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "lindvimera-probe-removal-selftest-"));
  const embeddedFiles = [
    "src/input/escape-preview.ts",
    "scripts/probe/cursor-color-regression.mjs",
    "scripts/probe/guide-regression.mjs",
    "test/engines/prepare-vendor.test.mjs",
    "test/probe/editing-cases.ts",
    "test/probe/ex-cases.ts",
    "test/probe/folding-cases.ts",
    "test/probe/hint-cases.ts",
    "test/probe/host-regression.ts",
    "test/probe/main.ts",
    "test/probe/performance.ts",
    "test/probe/runtime.ts",
    "test/probe/runtime.test.ts",
    "test/probe/smart-list-cases.ts",
    "test/probe/structure-cases.ts",
    "test/probe/table-probe.ts",
    "test/probe/view.ts",
  ];
  const retainedFiles = [
    "test/probe/builtin-main.ts",
    "test/probe/styles.css",
    "test/probe/build-boundaries.test.mjs",
    "test/probe/artifact-identity.test.mjs",
  ];
  const files = {
    "src/engines/embedded/index.ts": "export const realEmbedded = true;",
    "src/engines/builtin/index.ts": "export const realBuiltin = true;",
    "src/engines/builtin/policy.ts": "export const analyseKeyBindings = () => ({});",
    "src/engines/registry.ts": "unused before rewrite",
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: {} } }),
    "package.json": JSON.stringify({ scripts: { build: "node esbuild.config.mjs" } }),
    ...Object.fromEntries(
      [...embeddedFiles, ...retainedFiles].map((path) => [path, "placeholder"]),
    ),
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(sourceRoot, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  const target = createRemovalFixture({ sourceRoot, survivor: "builtin" });
  for (const path of embeddedFiles) assert.equal(existsSync(join(target, path)), false, path);
  for (const path of retainedFiles) assert.equal(existsSync(join(target, path)), true, path);
});

test("bundle inventory rejects removed source and hidden fork dependencies", () => {
  const metadata = (...paths) => ({ inputs: Object.fromEntries(paths.map((path) => [path, {}])) });
  assert.doesNotThrow(() =>
    assertEngineBoundary(metadata("src/main.ts", "src/engines/builtin/index.ts"), ["builtin"]),
  );
  for (const path of [
    "src/runtime/editor.ts",
    "src/engines/embedded/index.ts",
    ".generated/codemirror-vim/core.js",
    "node_modules/@replit/codemirror-vim/index.js",
  ])
    assert.throws(() => assertEngineBoundary(metadata(path), ["builtin"]), /Removed engine/);
  assert.throws(
    () => assertEngineBoundary(metadata("src/engines/builtin/native.ts"), ["embedded"]),
    /Removed engine/,
  );
});
