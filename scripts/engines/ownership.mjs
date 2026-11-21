/** Explicit deletion boundary; pure Markdown/word/table utilities are shared. */
export const ownership = Object.freeze({
  embedded: {
    devDependencies: ["@codemirror/search"],
    source: [
      "src/engines/embedded",
      "src/runtime",
      "src/ex",
      "src/navigation/session.ts",
      "src/table/session.ts",
      "src/folding/index.ts",
      "src/input/policy.ts",
      "src/input/hints.ts",
      "src/input/escape-preview.ts",
      "src/markdown/index.ts",
      "src/markdown/editing-runtime.ts",
    ],
    infrastructure: [
      "codemirror-vim",
      ".generated",
      "patches",
      ".gitmodules",
      "scripts/prepare-vendor.mjs",
      "tsconfig.vendor.json",
      "tsconfig.vendor-core.json",
      "scripts/probe/ci.mjs",
      "scripts/probe/cursor-color-regression.mjs",
      "scripts/probe/guide-regression.mjs",
      "scripts/probe/keyboard-regression.mjs",
      "scripts/probe/settings-regression.mjs",
    ],
    tests: [
      "test/engines/embedded.test.ts",
      "test/engines/embedded-word.test.ts",
      "test/engines/prepare-vendor.test.mjs",
      "test/ex",
      "test/runtime",
      "test/folding/session.test.ts",
      "test/input/policy.test.ts",
      "test/input/hints.test.ts",
      "test/input/operation-coverage.test.ts",
      "test/markdown/engine.test.ts",
      "test/markdown/line-editing-engine.test.ts",
      "test/navigation/session.test.ts",
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
      "test/table/session.test.ts",
      "test/table/host-fixture.ts",
      "test/word/engine.test.ts",
      "test/word/native-objects.test.ts",
      "test/word/native-objects.json",
      "test/word/sentence.test.ts",
    ],
  },
  builtin: {
    devDependencies: [],
    source: ["src/engines/builtin"],
    infrastructure: ["scripts/probe/builtin-ci.mjs"],
    tests: ["test/builtin*", "test/probe/builtin-main.ts"],
  },
});

export function ownsPath(engine, path) {
  const normalized = path.replaceAll("\\", "/");
  return [
    ...ownership[engine].source,
    ...ownership[engine].infrastructure,
    ...ownership[engine].tests,
  ].some((prefix) =>
    prefix.endsWith("*")
      ? normalized.startsWith(prefix.slice(0, -1))
      : normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}
