import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeFiles } from "../distribution.mjs";

export async function hashRuntimeFiles(directory) {
  return Object.fromEntries(
    await Promise.all(
      runtimeFiles.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(join(directory, file)))
          .digest("hex"),
      ]),
    ),
  );
}

export async function verifyRuntimeFiles(expected, directory) {
  const actual = await hashRuntimeFiles(directory);
  assert.deepEqual(actual, expected, "Production files differ from the tested candidate.");
  return actual;
}
