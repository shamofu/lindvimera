import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashRuntimeFiles, verifyRuntimeFiles } from "../../scripts/probe/artifact-identity.mjs";

test("installed production files must retain the tested candidate's exact bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lindvimera-artifact-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate");
  const installed = join(root, "installed");
  await mkdir(candidate);
  await mkdir(installed);
  const files = {
    "main.js": "production();",
    "manifest.json": '{"id":"lindvimera"}',
    "styles.css": ".production {}",
  };
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(candidate, file), content);
    await writeFile(join(installed, file), content);
  }
  const expected = await hashRuntimeFiles(candidate);
  assert.deepEqual(await verifyRuntimeFiles(expected, installed), expected);
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(installed, file), `${content}\nchanged`);
    await assert.rejects(
      verifyRuntimeFiles(expected, installed),
      /differ from the tested candidate/,
    );
    await writeFile(join(installed, file), content);
  }
  await rm(join(installed, "main.js"));
  await assert.rejects(verifyRuntimeFiles(expected, installed), { code: "ENOENT" });
});
