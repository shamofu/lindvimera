import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function git(cwd, args, encoding = "utf8") {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function containedPath(parent, child) {
  const result = resolve(parent, child);
  const rel = relative(parent, result);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path must remain inside ${parent}: ${child}`);
  }
  return result;
}

function assertNotLink(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing to replace a linked build path: ${path}`);
  }
}

/** Reconstruct the pinned Git tree, then apply each reviewed patch in order. */
export function prepareVendor() {
  const workspace = realpathSync(projectRoot);
  const manifest = JSON.parse(readFileSync(resolve(workspace, "patches/series.json"), "utf8"));
  if (!/^[0-9a-f]{40}$/.test(manifest.baseCommit)) {
    throw new Error("patches/series.json must pin a full 40-character baseCommit.");
  }
  if (!Array.isArray(manifest.patches)) throw new Error("Patch series must be an array.");
  const source = containedPath(workspace, manifest.sourceDirectory);
  const actual = git(source, ["rev-parse", "HEAD"]).trim();
  if (actual !== manifest.baseCommit) {
    throw new Error(
      `Vim submodule revision mismatch: expected ${manifest.baseCommit}, received ${actual}.`,
    );
  }

  // Only these verified workspace descendants may be recursively replaced.
  const generated = containedPath(workspace, ".generated");
  const target = containedPath(generated, "codemirror-vim");
  assertNotLink(generated);
  assertNotLink(target);
  mkdirSync(generated, { recursive: true });
  if (realpathSync(generated) !== generated) {
    throw new Error("Generated directory resolves outside the expected workspace path.");
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target);

  const entries = git(source, ["ls-tree", "-rz", manifest.baseCommit]).split("\0").filter(Boolean);
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (!match) throw new Error(`Unsupported upstream tree entry: ${entry}`);
    const destination = containedPath(target, match[3]);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, git(source, ["cat-file", "blob", match[2]], null));
  }

  // Isolate git apply from the parent repository and its ignore rules.
  git(target, ["init", "--quiet"]);
  git(target, ["config", "core.autocrlf", "false"]);
  git(target, ["config", "core.eol", "lf"]);
  const seen = new Set();
  for (const patch of manifest.patches) {
    if (!patch.file || !patch.purpose || !Array.isArray(patch.tests) || patch.tests.length === 0) {
      throw new Error("Every patch needs a file, purpose, and non-empty regression tests list.");
    }
    if (seen.has(patch.file)) throw new Error(`Duplicate patch: ${patch.file}`);
    seen.add(patch.file);
    const patchPath = containedPath(resolve(workspace, "patches"), patch.file);
    try {
      git(target, ["apply", "--whitespace=error-all", patchPath]);
    } catch (error) {
      throw new Error(`Patch failed: ${patch.file}`, { cause: error });
    }
  }
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Prepared Vim source: ${prepareVendor()}`);
}
