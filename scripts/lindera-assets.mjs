import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = dirname(fileURLToPath(import.meta.resolve("lindera-wasm")));
const dictionaryArtifact = {
  file: "lindera-ipadic-6.0.0.zip",
  url: "https://github.com/lindera/lindera/releases/download/v6.0.0/lindera-ipadic-6.0.0.zip",
  sha256: "8433dbbb80d7588a565fb9247c1ac7aed3ca50c7463329e495f8bd905aece356",
};

const dictionaryNames = [
  "metadata.json",
  "dict.trie",
  "dict.valsidx",
  "dict.vals",
  "dict.wordsidx",
  "dict.words",
  "matrix.mtx",
  "char_def.bin",
  "unk.bin",
];
// Keep the complete upstream dictionary in the verified build cache for comparison.
// Surface-only tokenization does not read these morphological detail files.
const dictionaryDetailNames = ["dict.wordsidx", "dict.words"];
const runtimeDictionaryNames = dictionaryNames.filter(
  (name) => !dictionaryDetailNames.includes(name),
);

export const linderaRuntimeFiles = [
  "lindera/lindera_wasm_bg.wasm",
  ...runtimeDictionaryNames.map((name) => `lindera/ipadic/${name}`),
];
export const legacyLinderaFiles = [
  ...linderaRuntimeFiles,
  ...dictionaryDetailNames.map((name) => `lindera/ipadic/${name}`),
];
/** Read fixed IPADIC members from the verified ZIP archive. */
function zipMembers(bytes) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65_557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert(end >= 0, "Missing ZIP directory.");
  let cursor = bytes.readUInt32LE(end + 16);
  const members = new Map();
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50, "Invalid ZIP directory.");
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    members.set(name, {
      method: bytes.readUInt16LE(cursor + 10),
      size: bytes.readUInt32LE(cursor + 24),
      compressedSize: bytes.readUInt32LE(cursor + 20),
      offset: bytes.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  return (name) => {
    const entry = members.get(name);
    assert(entry, `Missing dictionary member: ${name}`);
    assert.equal(bytes.readUInt32LE(entry.offset), 0x04034b50, "Invalid ZIP member.");
    const from =
      entry.offset +
      30 +
      bytes.readUInt16LE(entry.offset + 26) +
      bytes.readUInt16LE(entry.offset + 28);
    const compressed = bytes.subarray(from, from + entry.compressedSize);
    const content =
      entry.method === 8
        ? inflateRawSync(compressed, { maxOutputLength: entry.size })
        : entry.method === 0
          ? compressed
          : null;
    assert(content && content.length === entry.size, `Unsupported dictionary member: ${name}`);
    return content;
  };
}

/**
 * Use the installed npm package for WASM and its license. Only the dictionary
 * needs a separate download. Verify its archive and extract fixed members on
 * every build so stale cache files cannot enter the distribution.
 */
export async function prepareAssets() {
  const cache = resolve(root, ".cache/lindera");
  await mkdir(cache, { recursive: true });
  const target = resolve(cache, dictionaryArtifact.file);
  let bytes;
  let downloaded = false;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(dictionaryArtifact.url);
    if (!response.ok)
      throw new Error(`Download failed (${response.status}): ${dictionaryArtifact.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    downloaded = true;
  }
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    dictionaryArtifact.sha256,
    `Integrity check failed: ${dictionaryArtifact.file}`,
  );
  if (downloaded) await writeFile(target, bytes);
  const readZipMember = zipMembers(bytes);
  const dictionaryDirectory = resolve(cache, "lindera-ipadic");
  await mkdir(dictionaryDirectory, { recursive: true });
  for (const name of [...dictionaryNames, "NOTICE.txt"]) {
    await writeFile(resolve(dictionaryDirectory, name), readZipMember(`lindera-ipadic/${name}`));
  }
  return {
    wasmPath: resolve(packageDirectory, "lindera_wasm_bg.wasm"),
    dictionaryPaths: dictionaryNames.map((name) => resolve(dictionaryDirectory, name)),
    noticePath: resolve(dictionaryDirectory, "NOTICE.txt"),
    licensePath: resolve(packageDirectory, "LICENSE"),
  };
}

export function distributionAssetSources(assets) {
  return new Map([
    ["lindera/lindera_wasm_bg.wasm", assets.wasmPath],
    ...runtimeDictionaryNames.map((name) => [
      `lindera/ipadic/${name}`,
      assets.dictionaryPaths[dictionaryNames.indexOf(name)],
    ]),
    ["lindera/LICENSE", assets.licensePath],
    ["lindera/ipadic/NOTICE.txt", assets.noticePath],
  ]);
}
