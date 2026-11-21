import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ownership, ownsPath } from "./ownership.mjs";

/** Remove one exact block from pnpm's pinned, indentation-based lock format.
 * Fail closed if its structure changes; do not parse/re-emit the manager document. */
function removeLockEntry(source, keys, expectedVersion) {
  const lines = source.split(/(?<=\n)/u);
  let first = 0;
  let last = lines.length;
  for (const [depth, key] of keys.entries()) {
    const heading = " ".repeat(depth * 2) + key + ":";
    const matches = [];
    for (let at = first; at < last; at++) if (lines[at].trimEnd() === heading) matches.push(at);
    assert.equal(matches.length, 1, `Expected one pinned lock entry: ${keys.join(" / ")}`);
    first = matches[0];
    for (let at = first + 1; at < last; at++) {
      if (lines[at].trim() && lines[at].search(/\S/u) <= depth * 2) {
        last = at;
        break;
      }
    }
  }
  if (expectedVersion) {
    const body = lines.slice(first + 1, last).map((line) => line.trim());
    assert.ok(
      body.includes(`specifier: ${expectedVersion}`) &&
        body.includes(`version: ${expectedVersion}`),
      "Owned dependency must have an exact pinned importer version.",
    );
  }
  lines.splice(first, last - first);
  return lines.join("");
}

function pruneOwnedDependencies(target, dependencies) {
  const manifestPath = join(target, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const removed = dependencies.filter((name) =>
    Object.hasOwn(manifest.devDependencies ?? {}, name),
  );
  if (!removed.length) return;
  const lockPath = join(target, "pnpm-lock.yaml");
  const original = readFileSync(lockPath, "utf8");
  const documents = [...original.matchAll(/^---(?:\r?\n|$)/gm)];
  assert.equal(documents.length, 2, "Expected manager and application pnpm lock documents.");
  const applicationStart = documents[1].index;
  let application = original.slice(applicationStart);
  for (const name of removed) {
    const version = manifest.devDependencies[name];
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u, "Owned devDependency must be pinned.");
    application = removeLockEntry(
      application,
      ["importers", ".", "devDependencies", `'${name}'`],
      version,
    );
    for (const section of ["packages", "snapshots"])
      application = removeLockEntry(application, [section, `'${name}@${version}'`]);
    assert.ok(
      !application.includes(name),
      `Owned dependency still has a surviving lock reference: ${name}`,
    );
    delete manifest.devDependencies[name];
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(lockPath, original.slice(0, applicationStart) + application);
}

function ownedDependencyPath(path, dependencies) {
  const normalized = "/" + path.replaceAll("\\", "/");
  return dependencies.some((name) => {
    const direct = `/node_modules/${name}`;
    return (
      normalized === direct ||
      normalized.endsWith(direct) ||
      normalized.includes(direct + "/") ||
      normalized.includes(`/.pnpm/${name.replaceAll("/", "+")}@`)
    );
  });
}

function registry(engine) {
  const embedded = engine === "embedded";
  return `import { analyseKeyBindings as analyse } from ${JSON.stringify(embedded ? "../input/policy" : "./builtin/policy")};
import type { EngineId } from "./selection";
import type { EngineModule, MappingAnalyzer } from "./types";
export interface EngineDescriptor { id: EngineId; label: string; experimental: boolean; nativeVim: boolean; analyse: MappingAnalyzer; load(): Promise<EngineModule>; }
export const engineRegistry: readonly EngineDescriptor[] = [{ id: "${engine}", label: "${embedded ? "同梱エンジン" : "組み込みVim（実験的）"}", experimental: ${!embedded}, nativeVim: ${!embedded}, analyse, load: () => import("./${engine}") }];
export const defaultEngine: EngineId = "${engine}";
export function getEngine(id: EngineId = defaultEngine): EngineDescriptor { const engine = engineRegistry.find(entry => entry.id === id); if (!engine) throw new Error(\`Vim engine is unavailable: \${id}\`); return engine; }
`;
}

/** Build a fresh, physically filtered source tree. Never deletes or modifies the source. */
export function createRemovalFixture({
  sourceRoot = fileURLToPath(new URL("../../", import.meta.url)),
  survivor,
  outputRoot,
  copyDependencies = false,
} = {}) {
  assert(["embedded", "builtin"].includes(survivor), "Choose embedded or builtin.");
  sourceRoot = realpathSync(sourceRoot);
  const parent = resolve(sourceRoot, ".test-runtime/engine-removal");
  const target = resolve(outputRoot ?? join(parent, `${survivor}-${Date.now()}`));
  const rel = relative(parent, target);
  assert(
    rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    "Fixture must remain inside .test-runtime/engine-removal.",
  );
  assert(!existsSync(target), "Fixture destination already exists.");
  mkdirSync(parent, { recursive: true });
  assert.equal(realpathSync(parent), parent, "Fixture parent must not be a link.");
  mkdirSync(target);
  const removed = survivor === "embedded" ? "builtin" : "embedded";
  const removedDependencies = ownership[removed].devDependencies;
  const omitted = [];
  for (const entry of readdirSync(sourceRoot)) {
    if (
      [
        ".git",
        ".generated",
        ".test-runtime",
        ".test-vault",
        ".cache",
        "node_modules",
        "dist",
        "coverage",
        "test-results",
        ".release",
        ".release-gate",
      ].includes(entry)
    )
      continue;
    cpSync(join(sourceRoot, entry), join(target, entry), {
      recursive: true,
      verbatimSymlinks: true,
      filter(path) {
        const local = relative(sourceRoot, path).replaceAll("\\", "/");
        const omit = ownsPath(removed, local);
        if (omit) omitted.push(local);
        return !omit;
      },
    });
  }
  const writeJson = (path, value) =>
    writeFileSync(join(target, path), JSON.stringify(value, null, 2) + "\n");
  pruneOwnedDependencies(target, removedDependencies);
  writeFileSync(join(target, "src/engines/registry.ts"), registry(survivor));
  if (survivor === "builtin") {
    const config = JSON.parse(readFileSync(join(target, "tsconfig.json"), "utf8"));
    config.compilerOptions.paths = {};
    writeJson("tsconfig.json", config);
  } else if (existsSync(join(target, "codemirror-vim/.git"))) {
    const pointer = readFileSync(join(sourceRoot, "codemirror-vim/.git"), "utf8").trim();
    assert(pointer.startsWith("gitdir: "), "Expected pinned submodule gitdir pointer.");
    // Windows preserves the submodule marker's Hidden attribute; r+ can update it.
    writeFileSync(
      join(target, "codemirror-vim/.git"),
      `gitdir: ${resolve(sourceRoot, "codemirror-vim", pointer.slice(8))}\n`,
      { flag: "r+" },
    );
  }
  if (copyDependencies) {
    const links = [];
    cpSync(join(sourceRoot, "node_modules"), join(target, "node_modules"), {
      recursive: true,
      filter(path) {
        if (ownedDependencyPath(relative(sourceRoot, path), removedDependencies)) return false;
        if (!lstatSync(path).isSymbolicLink()) return true;
        links.push(path);
        return false;
      },
    });
    for (const source of links) {
      const destination = join(target, relative(sourceRoot, source));
      const original = resolve(dirname(source), readlinkSync(source));
      const local = relative(sourceRoot, original);
      if (ownedDependencyPath(local, removedDependencies)) continue;
      assert(
        local && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local),
        `Dependency link escapes installed tree: ${source}`,
      );
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(
        join(target, local),
        destination,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  }
  if (existsSync(join(sourceRoot, ".cache/lindera")))
    cpSync(join(sourceRoot, ".cache/lindera"), join(target, ".cache/lindera"), { recursive: true });
  const sourceHashes = {};
  const hashTree = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) hashTree(path);
      else
        sourceHashes[relative(target, path).replaceAll("\\", "/")] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
    }
  };
  hashTree(join(target, "src"));
  const sourceHash = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(sourceHashes).sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");
  writeJson("source-hashes.json", sourceHashes);
  writeJson("engine-removal.json", {
    survivor,
    removed,
    sourceRoot,
    omitted,
    removedDevDependencies: removedDependencies,
    dependencies: copyDependencies ? "copied-installed-snapshot" : "not-installed",
    created: new Date().toISOString(),
    sourceHash,
  });
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(
    createRemovalFixture({
      survivor: process.argv[2],
      copyDependencies: process.argv.includes("--copy-dependencies"),
    }),
  );
