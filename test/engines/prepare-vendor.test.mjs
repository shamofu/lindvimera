import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareVendor } from "../../scripts/prepare-vendor.mjs";

const samplePatch = [
  "diff --git a/src/index.ts b/src/index.ts",
  "--- a/src/index.ts",
  "+++ b/src/index.ts",
  "@@ -1 +1,2 @@",
  " export const original = true;",
  "+export const patched = true;",
  "",
].join("\n");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function createVendorWorkspace(patchesOverride) {
  const container = mkdtempSync(join(tmpdir(), "lindvimera-prepare-vendor-"));
  const root = join(container, "workspace");
  const upstream = join(root, "codemirror-vim");
  mkdirSync(join(upstream, "src"), { recursive: true });
  mkdirSync(join(root, "patches"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });

  writeFileSync(join(upstream, "src/index.ts"), "export const original = true;\n");
  git(upstream, ["init", "--quiet"]);
  git(upstream, ["config", "core.autocrlf", "false"]);
  git(upstream, ["config", "core.eol", "lf"]);
  git(upstream, ["config", "user.name", "Test User"]);
  git(upstream, ["config", "user.email", "test@example.com"]);
  git(upstream, ["add", "."]);
  git(upstream, ["commit", "--quiet", "-m", "initial"]);
  const baseCommit = git(upstream, ["rev-parse", "HEAD"]);

  writeFileSync(join(root, "patches/0001-sample.patch"), samplePatch);
  writeFileSync(join(root, "test/sample.test.ts"), "export const sampleTest = true;\n");
  writeFileSync(join(container, "outside.test.ts"), "export const outside = true;\n");

  const patches = patchesOverride ?? [
    {
      file: "0001-sample.patch",
      purpose: "Add patched export",
      tests: ["test/sample.test.ts"],
    },
  ];
  writeFileSync(
    join(root, "patches/series.json"),
    JSON.stringify({ baseCommit, sourceDirectory: "codemirror-vim", patches }, null, 2),
  );
  return { container, root };
}

test("prepareVendor prepares a valid workspace and applies patches", () => {
  const { container, root } = createVendorWorkspace();
  try {
    const target = prepareVendor(root);
    assert.equal(target, join(realpathSync(root), ".generated", "codemirror-vim"));
    assert.equal(
      readFileSync(join(target, "src/index.ts"), "utf8"),
      "export const original = true;\nexport const patched = true;\n",
    );
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("prepareVendor rejects a missing regression test file", () => {
  const { container, root } = createVendorWorkspace([
    {
      file: "0001-sample.patch",
      purpose: "Add patched export",
      tests: ["test/missing.test.ts"],
    },
  ]);
  try {
    assert.throws(() => prepareVendor(root), /Missing regression test.*test\/missing\.test\.ts/);
    assert.equal(existsSync(join(root, ".generated/codemirror-vim")), false);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("prepareVendor rejects regression test paths escaping the workspace", () => {
  const { container, root } = createVendorWorkspace([
    {
      file: "0001-sample.patch",
      purpose: "Add patched export",
      tests: ["../outside.test.ts"],
    },
  ]);
  try {
    assert.throws(() => prepareVendor(root), /Path must remain inside/);
    assert.equal(existsSync(join(root, ".generated/codemirror-vim")), false);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("prepareVendor rejects non-string, empty, and duplicate manifest entries", () => {
  for (const [label, patches, pattern] of [
    [
      "non-string test path",
      [{ file: "0001-sample.patch", purpose: "Add patched export", tests: [123] }],
      /Missing regression test/,
    ],
    [
      "empty tests array",
      [{ file: "0001-sample.patch", purpose: "Add patched export", tests: [] }],
      /non-empty regression tests list/,
    ],
    [
      "duplicate patch entry",
      [
        { file: "0001-sample.patch", purpose: "First", tests: ["test/sample.test.ts"] },
        { file: "0001-sample.patch", purpose: "Duplicate", tests: ["test/sample.test.ts"] },
      ],
      /Duplicate patch: 0001-sample\.patch/,
    ],
  ]) {
    const { container, root } = createVendorWorkspace(patches);
    try {
      assert.throws(() => prepareVendor(root), pattern, label);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  }
});
