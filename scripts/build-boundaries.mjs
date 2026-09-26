import assert from "node:assert/strict";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** These private parser trees must not depend on the host's Lezer module versions. */
export function assertBundledMarkdown(metafile) {
  const inputs = Object.keys(metafile.inputs ?? {}).map((path) => path.replaceAll("\\", "/"));
  for (const name of ["markdown", "common", "highlight"])
    assert(
      inputs.some((path) => path.includes(`node_modules/@lezer/${name}/`)),
      `The production bundle must include @lezer/${name}.`,
    );
  for (const output of Object.values(metafile.outputs ?? {}))
    for (const imported of output.imports ?? [])
      assert(
        !(
          imported.external && /^@lezer\/(?:markdown|common|highlight)(?:\/|$)/.test(imported.path)
        ),
        `Private parser dependency escaped the bundle: ${imported.path}`,
      );
}

export function assertBundleBoundary(metafile, kind) {
  assert(metafile?.inputs, "The bundle must provide an esbuild input inventory.");
  assert(["production", "harness"].includes(kind), `Unknown bundle kind: ${kind}`);
  for (const input of Object.keys(metafile.inputs)) {
    const path = relative(root, resolve(root, input)).replaceAll("\\", "/");
    if (kind === "production")
      assert(
        !/^(?:test\/|src\/probe\/|scripts\/probe\/)/.test(path),
        `Test-only code entered the production bundle: ${path}`,
      );
    else
      assert(
        path.startsWith("test/probe/") && !/\.test\.[cm]?[jt]s$/.test(path),
        `The harness must use installed runtime references, not bundle implementations: ${path}`,
      );
  }
}
