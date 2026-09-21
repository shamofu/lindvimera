// @vitest-environment node
import { expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { createBundledAssetReader } from "../../src/word/asset-reader";

function packed(bytes: Uint8Array) {
  return {
    gzipBase64: gzipSync(bytes).toString("base64"),
    bytes: bytes.length,
  };
}

it("lazily decompresses bundled bytes and returns an exact standalone buffer", async () => {
  const source = new Uint8Array([0, 1, 2, 128, 255]);
  const reader = createBundledAssetReader({ "dictionary.bin": packed(source) });
  const result = await reader("dictionary.bin");
  expect(result.byteLength).toBe(source.length);
  expect(new Uint8Array(result)).toEqual(source);
});

it("rejects missing and corrupted assets for the existing service fallback", async () => {
  const reader = createBundledAssetReader({
    corrupted: { gzipBase64: "broken", bytes: 10 },
  });
  await expect(reader("missing")).rejects.toThrow("Missing bundled asset");
  await expect(reader("toString")).rejects.toThrow("Missing bundled asset");
  await expect(reader("corrupted")).rejects.toThrow();
});

it("bounds decompression and rejects truncated asset contents", async () => {
  const source = new Uint8Array([1, 2, 3, 4, 5]);
  const reader = createBundledAssetReader({
    small: { ...packed(source), bytes: 4 },
    large: { ...packed(source), bytes: 6 },
  });
  await expect(reader("small")).rejects.toThrow();
  await expect(reader("large")).rejects.toThrow("Invalid bundled asset size");
});
