import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export function availableEngines(root = projectRoot) {
  return ["embedded", "builtin"].filter((engine) =>
    existsSync(join(root, `src/engines/${engine}/index.ts`)),
  );
}
export function vimAliases(root = projectRoot) {
  if (!availableEngines(root).includes("embedded")) return {};
  return {
    "@replit/codemirror-vim": join(
      root,
      ".generated/codemirror-vim/packages/codemirror-vim/src/index.ts",
    ),
    "@replit/codemirror-vim-core": join(
      root,
      ".generated/codemirror-vim/packages/codemirror-vim-core/vim.js",
    ),
  };
}
export async function prepareEngineSources(root = projectRoot) {
  if (availableEngines(root).includes("embedded")) {
    const { prepareVendor } = await import(
      pathToFileURL(join(root, "scripts/prepare-vendor.mjs")).href
    );
    prepareVendor();
  }
}
