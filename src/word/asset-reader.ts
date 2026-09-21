import { Buffer } from "node:buffer";
import { gunzip } from "node:zlib";

export interface EmbeddedAsset {
  gzipBase64: string;
  bytes: number;
}

/** Decode only when the word service asks for a file, without network or disk I/O. */
export function createBundledAssetReader(assets: Readonly<Record<string, EmbeddedAsset>>) {
  return async (path: string): Promise<ArrayBuffer> => {
    if (!Object.hasOwn(assets, path)) throw new Error(`Missing bundled asset: ${path}`);
    const asset = assets[path];
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      gunzip(
        Buffer.from(asset.gzipBase64, "base64"),
        { maxOutputLength: asset.bytes },
        (error, result) => (error ? reject(error) : resolve(result)),
      );
    });
    if (bytes.length !== asset.bytes) throw new Error(`Invalid bundled asset size: ${path}`);
    return Uint8Array.from(bytes).buffer;
  };
}
