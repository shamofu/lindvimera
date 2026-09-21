import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { distributionFiles } from "../../scripts/distribution.mjs";
import { validateDistribution } from "../../scripts/release/validate.mjs";

const packageScript = fileURLToPath(new URL("../../scripts/release/package.ps1", import.meta.url));
const version = "0.2.0";
const commit = "a".repeat(40);
const digest = (content) => createHash("sha256").update(content).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lindvimera-distribution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { id: "lindvimera", version, minAppVersion: "1.13.7", isDesktopOnly: true };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(join(root, "versions.json"), JSON.stringify({ [version]: "1.13.7" }));
  await writeFile(join(root, "styles.css"), ".lindvimera { color: inherit; }\n");
  for (const file of distributionFiles) {
    const path = join(root, "dist", file);
    await mkdir(dirname(path), { recursive: true });
    const content = ["manifest.json", "styles.css"].includes(file)
      ? await readFile(join(root, file))
      : file === "main.js"
        ? "module.exports = {};\n"
        : `Retained distribution file: ${file}\n`;
    await writeFile(path, content);
  }
  return root;
}

function packageDistribution(root, overrides = {}) {
  return execFileSync("pwsh", ["-NoProfile", "-File", packageScript], {
    encoding: "utf8",
    windowsHide: true,
    stdio: "pipe",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: root,
      GITHUB_SHA: commit,
      GITHUB_REPOSITORY: "example/lindvimera",
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "2",
      RELEASE_VERSION: version,
      ...overrides,
    },
  });
}

test("validates the complete tested distribution and expected release version", async (t) => {
  const root = await fixture(t);
  assert.equal(await validateDistribution({ root, version }), version);
  await assert.rejects(validateDistribution({ root, version: "0.3.0" }), /release version differs/);
});

for (const [name, mutate, message] of [
  [
    "mismatched source versions",
    (root) => writeFile(join(root, "package.json"), JSON.stringify({ version: "0.1.0" })),
    /Package and manifest versions differ/,
  ],
  [
    "an unregistered minimum app version",
    (root) => writeFile(join(root, "versions.json"), JSON.stringify({ [version]: "1.12.0" })),
    /Update versions.json/,
  ],
  ["a missing retained file", (root) => rm(join(root, "dist", "LICENSE")), /inventory differs/],
  [
    "an unexpected distribution file",
    (root) => writeFile(join(root, "dist", "main.js.map"), "{}"),
    /inventory differs/,
  ],
  ["an empty file", (root) => writeFile(join(root, "dist", "main.js"), ""), /Empty distribution/],
  [
    "stale CSS",
    (root) => writeFile(join(root, "dist", "styles.css"), ".old {}"),
    /Stale styles.css/,
  ],
  [
    "stale manifest content",
    (root) => writeFile(join(root, "dist", "manifest.json"), "{}"),
    /Stale manifest.json/,
  ],
  [
    "a development source map reference",
    (root) =>
      writeFile(
        join(root, "dist", "main.js"),
        "module.exports = {};\n//# sourceMappingURL=data:application/json;base64,e30=",
      ),
    /Development source maps/,
  ],
]) {
  test(`rejects ${name}`, async (t) => {
    const root = await fixture(t);
    await mutate(root);
    await assert.rejects(validateDistribution({ root }), message);
  });
}

test("rejects a linked directory even when the normal inventory remains present", async (t) => {
  const root = await fixture(t);
  const target = join(root, "outside-distribution");
  await mkdir(target);
  await symlink(target, join(root, "dist", "linked"), "junction");
  await assert.rejects(validateDistribution({ root }), /symbolic links/);
});

test("packages the tested bytes with a complete ZIP, checksums, and this run's provenance", async (t) => {
  const root = await fixture(t);
  await validateDistribution({ root, version });
  const testedFiles = Object.fromEntries(
    await Promise.all(
      distributionFiles.map(async (file) => [
        file,
        await readFile(join(root, "dist", file), "utf8"),
      ]),
    ),
  );
  packageDistribution(root);
  const directory = join(root, ".release");
  const zip = `lindvimera-${version}.zip`;
  const files = ["main.js", "manifest.json", "styles.css", zip, "SHA256SUMS", "provenance.json"];
  assert.deepEqual((await readdir(directory)).sort(), [...files].sort());
  const info = JSON.parse(await readFile(join(root, ".release-gate", "info.json"), "utf8"));
  const provenance = JSON.parse(await readFile(join(directory, "provenance.json"), "utf8"));
  const expectedIdentity = {
    schemaVersion: 2,
    repository: "example/lindvimera",
    commit,
    version,
    runId: "12345",
    runAttempt: 2,
  };
  const { hashes, ...infoIdentity } = info;
  const { files: provenanceFiles, ...provenanceIdentity } = provenance;
  assert.deepEqual(infoIdentity, expectedIdentity);
  assert.deepEqual(provenanceIdentity, expectedIdentity);
  assert.deepEqual(Object.keys(hashes).sort(), [...files].sort());
  assert.deepEqual(
    Object.keys(provenanceFiles).sort(),
    files.filter((file) => file !== "provenance.json").sort(),
  );
  for (const file of files) {
    assert.equal(hashes[file], digest(await readFile(join(directory, file))));
    if (file !== "provenance.json") assert.equal(provenanceFiles[file], hashes[file]);
  }
  assert.equal(
    await readFile(join(directory, "SHA256SUMS"), "utf8"),
    files
      .slice(0, 4)
      .map((file) => `${hashes[file]}  ${file}\n`)
      .join(""),
  );
  for (const file of ["main.js", "manifest.json", "styles.css"])
    assert.equal(await readFile(join(directory, file), "utf8"), testedFiles[file]);
  for (const file of distributionFiles)
    assert.equal(await readFile(join(root, "dist", file), "utf8"), testedFiles[file]);

  const entries = JSON.parse(
    execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `
    $ErrorActionPreference = 'Stop'
    $archive = [IO.Compression.ZipFile]::OpenRead($env:LINDVIMERA_TEST_ARCHIVE)
    try {
      @($archive.Entries | Where-Object Name | ForEach-Object {
        $reader = [IO.StreamReader]::new($_.Open())
        try { @{ path = $_.FullName; content = $reader.ReadToEnd() } } finally { $reader.Dispose() }
      }) | ConvertTo-Json -Compress
    } finally { $archive.Dispose() }
  `,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, LINDVIMERA_TEST_ARCHIVE: join(directory, zip) },
      },
    ),
  );
  assert.deepEqual(
    Object.fromEntries(entries.map(({ path, content }) => [path, content])),
    Object.fromEntries(
      Object.entries(testedFiles).map(([file, content]) => [`lindvimera/${file}`, content]),
    ),
  );
});

test("refuses packaging with a mismatched release version or stale output", async (t) => {
  const root = await fixture(t);
  assert.throws(
    () => packageDistribution(root, { RELEASE_VERSION: "0.3.0" }),
    /Distribution manifest differs/,
  );
  await mkdir(join(root, ".release"));
  await writeFile(join(root, ".release", "unexpected.txt"), "old output");
  assert.throws(() => packageDistribution(root), /Release output must be empty/);
  assert.deepEqual(await readdir(join(root, ".release")), ["unexpected.txt"]);
});
