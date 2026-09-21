import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backfillReleaseNotes, updateReleaseBody } from "../../scripts/release/backfill-notes.mjs";
import { NOTES_END, NOTES_START } from "../../scripts/release/notes.mjs";

const repository = "owner/project";
const marker = '<!-- lindvimera-release:{"schemaVersion":1,"artifactId":123,"commit":"old"} -->';
const markdown = `${NOTES_START}\n## Changes\n\n- Example commit\n${NOTES_END}\n`;

function update(body, overrides = {}) {
  return updateReleaseBody({ body, tag: "0.2.0", repository, markdown, ...overrides });
}

test("removes only known redundant lines while retaining prose and exact schema 1 marker", () => {
  const prose = "Installation instructions.\n\nLindvimera 0.1.0\nVerified main CI: documentation";
  const body = `Lindvimera 0.2.0\n\n${prose}\n\nVerified main CI: https://github.com/owner/project/actions/runs/123\n\n${marker}`;
  const updated = update(body);
  assert.ok(updated.startsWith(markdown));
  assert.ok(!updated.includes("Lindvimera 0.2.0"));
  assert.ok(!updated.includes("/actions/runs/123"));
  assert.ok(updated.includes(prose));
  assert.ok(updated.endsWith(marker));
  assert.equal(update(updated), updated);
});

test("replaces the managed block in place and preserves surrounding handwritten paragraphs", () => {
  const oldBlock = `${NOTES_START}\nold notes\n${NOTES_END}`;
  const body = `Opening paragraph.\n\n${oldBlock}\n\nClosing paragraph.\n${marker}`;
  const updated = update(body);
  assert.equal(
    updated,
    `Opening paragraph.\n\n${markdown.trimEnd()}\n\nClosing paragraph.\n${marker}`,
  );
  assert.equal(update(updated), updated);
});

test("rejects incomplete, reversed, and duplicate managed blocks", () => {
  for (const body of [
    NOTES_START,
    NOTES_END,
    `${NOTES_END}\n${NOTES_START}`,
    `${markdown}\n${markdown}`,
    `${NOTES_START}\n${NOTES_START}\n${NOTES_END}`,
    "<!-- lindvimera-notes:start-->",
    "<!-- lindvimera-notes:unknown -->",
  ]) {
    assert.throws(() => update(body), /malformed or duplicate/);
  }
});

test("handles empty and CRLF legacy bodies without adding a visible version or CI line", () => {
  assert.equal(update(""), markdown.trimEnd());
  assert.equal(
    update(
      `Lindvimera 0.2.0\r\n\r\nVerified main CI: https://github.com/owner/project/actions/runs/123\r\n\r\n${marker}`,
    ),
    `${markdown}\n${marker}`,
  );
});

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "lindvimera-backfill-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  function git(...args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "--initial-branch=main");
  git("config", "user.name", "Backfill test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-m", "init: the Lindvimera awakens");
  git("tag", "0.1.0");
  for (const subject of ["chore: improve plugin health", "feat: expand Vim editing", "v0.2.0"]) {
    git("commit", "--allow-empty", "-m", subject);
  }
  git("tag", "0.2.0");
  const releases = ["0.1.0", "0.2.0"].map((tag, index) => ({
    id: index + 1,
    tag_name: tag,
    name: `Original ${tag}`,
    target_commitish: "release",
    draft: false,
    prerelease: false,
    published_at: "2026-09-21T00:00:00Z",
    body: `Lindvimera ${tag}\n\nVerified main CI: https://github.com/owner/project/actions/runs/123\n\n<!-- lindvimera-release:${JSON.stringify({ schemaVersion: 1, artifactId: 123, commit: git("rev-parse", `refs/tags/${tag}^{commit}`) })} -->`,
    assets: [
      { id: 100 + index, name: "main.js", state: "uploaded", size: 200, digest: "sha256:abc" },
    ],
  }));
  const calls = [];
  const readCounts = new Map();
  let beforeRead;
  let afterPatch;
  function gh(args, options) {
    calls.push({ args, options });
    if (args.includes("--paginate")) return JSON.stringify([releases]);
    const id = Number(args[1].split("/").at(-1));
    const release = releases.find((item) => item.id === id);
    assert.ok(release);
    if (args.includes("PATCH")) {
      Object.assign(release, JSON.parse(options.input));
      afterPatch?.(release);
    } else {
      const count = (readCounts.get(id) ?? 0) + 1;
      readCounts.set(id, count);
      beforeRead?.(release, count);
    }
    return JSON.stringify(release);
  }
  function run(options = {}) {
    return backfillReleaseNotes({
      repository,
      cwd,
      gh,
      snapshotDirectory: join(cwd, "snapshots"),
      ...options,
    });
  }
  return {
    cwd,
    git,
    releases,
    calls,
    run,
    onRead: (callback) => (beforeRead = callback),
    onPatch: (callback) => (afterPatch = callback),
  };
}

test("preview generates the initial one-commit and subsequent three-commit notes without API writes", (t) => {
  const repo = fixture(t);
  const original = structuredClone(repo.releases);
  const result = repo.run();
  assert.equal(result.applied, false);
  assert.deepEqual(
    result.releases.map(({ tag, commits }) => ({ tag, commits })),
    [
      { tag: "0.1.0", commits: 1 },
      { tag: "0.2.0", commits: 3 },
    ],
  );
  assert.deepEqual(repo.releases, original);
  assert.ok(!repo.calls.some(({ args }) => args.includes("PATCH")));
  const snapshot = JSON.parse(readFileSync(join(result.snapshotDirectory, "0.1.0-1.before.json")));
  assert.deepEqual(snapshot.assets, original[0].assets);
  assert.ok(!result.releases[0].body.includes("/compare/"));
  assert.ok(result.releases[1].body.includes("/compare/0.1.0...0.2.0"));
});

test("apply patches only body, re-reads unchanged assets and metadata, and is idempotent", (t) => {
  const repo = fixture(t);
  const original = structuredClone(repo.releases);
  const result = repo.run({ apply: true });
  assert.equal(result.applied, true);
  const mutations = repo.calls.filter(({ args }) => args.includes("PATCH"));
  assert.equal(mutations.length, 2);
  for (const { args, options } of mutations) {
    assert.deepEqual(args.slice(2), ["--method", "PATCH", "--input", "-"]);
    assert.deepEqual(Object.keys(JSON.parse(options.input)), ["body"]);
  }
  for (let index = 0; index < original.length; index += 1) {
    const { body: beforeBody, ...before } = original[index];
    const { body: afterBody, ...after } = repo.releases[index];
    assert.notEqual(afterBody, beforeBody);
    assert.ok(afterBody.endsWith(beforeBody.slice(beforeBody.indexOf("<!-- lindvimera-release:"))));
    assert.deepEqual(after, before);
    const snapshot = JSON.parse(
      readFileSync(join(result.snapshotDirectory, `${after.tag_name}-${after.id}.after.json`)),
    );
    assert.deepEqual(snapshot, repo.releases[index]);
  }
  const second = repo.run({ apply: true, snapshotDirectory: join(repo.cwd, "second") });
  assert.ok(second.releases.every(({ changed }) => !changed));
  assert.equal(repo.calls.filter(({ args }) => args.includes("PATCH")).length, 2);
});

test("concurrent body changes prevent writing the affected release", (t) => {
  const repo = fixture(t);
  repo.onRead((release, count) => {
    if (release.id === 1 && count === 2) release.body += "\nHuman edit";
  });
  assert.throws(() => repo.run({ apply: true }), /changed concurrently/);
  assert.equal(repo.calls.filter(({ args }) => args.includes("PATCH")).length, 0);
});

test("concurrent asset changes prevent writing the affected release", (t) => {
  const repo = fixture(t);
  repo.onRead((release, count) => {
    if (release.id === 1 && count === 2) release.assets[0].digest = "sha256:changed";
  });
  assert.throws(() => repo.run({ apply: true }), /changed concurrently/);
  assert.equal(repo.calls.filter(({ args }) => args.includes("PATCH")).length, 0);
});

test("unexpected asset or publication changes after PATCH fail verification", (t) => {
  const repo = fixture(t);
  repo.onPatch((release) => {
    release.draft = true;
  });
  assert.throws(() => repo.run({ apply: true }), /failed verification/);
  assert.equal(repo.calls.filter(({ args }) => args.includes("PATCH")).length, 1);
});

test("bad notes in a later release prevent every write", (t) => {
  const repo = fixture(t);
  repo.releases[1].body += `\n${NOTES_START}`;
  assert.throws(() => repo.run({ apply: true }), /malformed or duplicate/);
  assert.equal(repo.calls.filter(({ args }) => args.includes("PATCH")).length, 0);
});

test("missing history prevents every write", (t) => {
  const repo = fixture(t);
  repo.git("tag", "-d", "0.1.0");
  assert.throws(() => repo.run({ apply: true }), /Git history is unavailable/);
  assert.equal(repo.calls.filter(({ args }) => args.includes("PATCH")).length, 0);
});

test("a moved published tag is rejected using its preserved provenance", (t) => {
  const repo = fixture(t);
  repo.git("tag", "-f", "0.1.0", "0.2.0");
  assert.throws(() => repo.run({ apply: true }), /no longer matches its published provenance/);
  assert.equal(repo.calls.filter(({ args }) => args.includes("PATCH")).length, 0);
});
