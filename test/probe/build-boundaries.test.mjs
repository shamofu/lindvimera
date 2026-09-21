import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBundleBoundary } from "../../scripts/build-boundaries.mjs";

const inputs = (...paths) => ({ inputs: Object.fromEntries(paths.map((path) => [path, {}])) });

test("production accepts runtime code but rejects harness or legacy probe imports", () => {
  assert.doesNotThrow(() =>
    assertBundleBoundary(inputs("src/main.ts", "src/runtime/internal.ts"), "production"),
  );
  for (const path of ["test/probe/view.ts", "src/probe/view.ts", "scripts/probe/run.mjs"])
    assert.throws(() => assertBundleBoundary(inputs(path), "production"), /Test-only code/);
});

test("the harness cannot bundle a second production or vendor implementation", () => {
  assert.doesNotThrow(() =>
    assertBundleBoundary(inputs("test/probe/main.ts", "test/probe/runtime.ts"), "harness"),
  );
  for (const path of [
    "src/runtime/editor.ts",
    ".generated/codemirror-vim/index.ts",
    "node_modules/budoux/index.js",
    "test/probe/runtime.test.ts",
  ])
    assert.throws(
      () => assertBundleBoundary(inputs(path), "harness"),
      /installed runtime references/,
    );
});
