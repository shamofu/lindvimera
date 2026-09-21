import { build } from "esbuild";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertBundleBoundary } from "../build-boundaries.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const harnessId = "lindvimera-test-harness";

export async function buildProbe(outdir = join(root, ".test-runtime", "harness")) {
  await mkdir(outdir, { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["test/probe/main.ts"],
    outfile: join(outdir, "main.js"),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    sourcemap: false,
    metafile: true,
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "node:*"],
    logLevel: "warning",
  });
  assertBundleBoundary(result.metafile, "harness");
  await copyFile(join(root, "test/probe/styles.css"), join(outdir, "styles.css"));
  await writeFile(
    join(outdir, "manifest.json"),
    JSON.stringify(
      {
        id: harnessId,
        name: "Lindvimera test harness",
        version: "0.0.0",
        minAppVersion: "1.13.7",
        description: "Regression workbench for the isolated disposable test Vault only.",
        author: "Lindvimera tests",
        isDesktopOnly: true,
      },
      null,
      2,
    ),
  );
  return outdir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await buildProbe();
