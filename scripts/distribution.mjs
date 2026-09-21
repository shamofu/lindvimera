import { fileURLToPath } from "node:url";

export const distributionDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
export const distributionAssets = [
  "manifest.json",
  "styles.css",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "src/word/text-object.ts",
];
export const upstreamNoticeFiles = ["lindera/LICENSE", "lindera/ipadic/NOTICE.txt"];
export const retainedFiles = [
  ...distributionAssets.filter((file) => !["manifest.json", "styles.css"].includes(file)),
  ...upstreamNoticeFiles,
];
export const distributionFiles = ["main.js", ...distributionAssets, ...upstreamNoticeFiles];
// These are the only files installed by the Obsidian community directory.
export const runtimeFiles = ["main.js", "manifest.json", "styles.css"];
