import { build, context } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Script } from "node:vm";
import { gzipSync } from "node:zlib";
import {
  distributionAssets,
  distributionDirectory,
  retainedFiles,
  upstreamNoticeFiles,
} from "./scripts/distribution.mjs";
import {
  distributionAssetSources,
  linderaRuntimeFiles,
  prepareAssets,
} from "./scripts/lindera-assets.mjs";
import { prepareVendor, projectRoot } from "./scripts/prepare-vendor.mjs";
import { assertBundleBoundary } from "./scripts/build-boundaries.mjs";

prepareVendor();
const watch = process.argv.includes("--watch");
async function copyAsset(file, source = join(projectRoot, file)) {
  const destination = join(distributionDirectory, file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
const options = {
  absWorkingDir: projectRoot,
  entryPoints: ["src/main.ts"],
  outfile: join(distributionDirectory, "main.js"),
  bundle: true,
  metafile: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  legalComments: "eof",
  logLevel: "info",
  alias: {
    "@replit/codemirror-vim": join(
      projectRoot,
      ".generated/codemirror-vim/packages/codemirror-vim/src/index.ts",
    ),
    "@replit/codemirror-vim-core": join(
      projectRoot,
      ".generated/codemirror-vim/packages/codemirror-vim-core/vim.js",
    ),
  },
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "node:*"],
  banner: {
    js: "/* Lindvimera — generated bundle. Licenses and adapted source are retained below. */",
  },
  plugins: [
    {
      name: "distribution-assets",
      setup(build) {
        let linderaAssets;
        let embeddedAssets;
        build.onStart(async () => {
          linderaAssets = distributionAssetSources(await prepareAssets());
          embeddedAssets = Object.fromEntries(
            await Promise.all(
              linderaRuntimeFiles.map(async (file) => {
                const bytes = await readFile(linderaAssets.get(file));
                return [
                  file,
                  {
                    gzipBase64: gzipSync(bytes, { level: 9 }).toString("base64"),
                    bytes: bytes.length,
                  },
                ];
              }),
            ),
          );
        });
        build.onResolve({ filter: /^lindvimera:assets$/ }, () => ({
          path: "lindvimera:assets",
          namespace: "lindvimera-assets",
        }));
        build.onLoad({ filter: /.*/, namespace: "lindvimera-assets" }, () => ({
          contents: `export default ${JSON.stringify(embeddedAssets)};`,
          loader: "js",
          watchFiles: distributionAssets.map((file) => join(projectRoot, file)),
        }));
        build.onEnd(async (result) => {
          if (result.errors.length === 0) {
            assertBundleBoundary(result.metafile, "production");
            const bundlePath = join(distributionDirectory, "main.js");
            const footer = await Promise.all(
              retainedFiles.map(async (file) => {
                const text = await readFile(
                  linderaAssets.get(file) ?? join(projectRoot, file),
                  "utf8",
                );
                return `// ${file}\n${text
                  .split(/\r\n|[\r\n\u2028\u2029]/u)
                  .map((line) => `// ${line}`)
                  .join("\n")}`;
              }),
            );
            const bundle = `${await readFile(bundlePath, "utf8")}\n${footer.join("\n\n")}\n`;
            new Script(bundle, { filename: "main.js" });
            await writeFile(bundlePath, bundle);
            await Promise.all([
              ...distributionAssets.map((file) => copyAsset(file)),
              ...upstreamNoticeFiles.map((file) => copyAsset(file, linderaAssets.get(file))),
              // Remove obsolete loose binaries left by an earlier local build.
              ...linderaRuntimeFiles.map((file) =>
                rm(join(distributionDirectory, file), { force: true }),
              ),
            ]);
          }
        });
      },
    },
  ],
};
if (watch) {
  const session = await context(options);
  await session.watch();
} else {
  await build(options);
}
