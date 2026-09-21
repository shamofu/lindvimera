import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  compareVersions,
  fetchPublishedReleases,
  generateReleaseNotes,
  NOTES_END,
  NOTES_START,
} from "../../scripts/release/notes.mjs";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "lindvimera-notes-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  function git(...args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release notes test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  function commit(subject, tag) {
    git("commit", "--allow-empty", "-m", subject);
    if (tag) git("tag", tag);
    return git("rev-parse", "HEAD");
  }
  function notes(tag, releases, overrides = {}) {
    return generateReleaseNotes({
      repository: "owner/project",
      tag,
      commit: git("rev-parse", `refs/tags/${tag}^{commit}`),
      releases: releases.map((version) =>
        typeof version === "string" ? published(version) : version,
      ),
      cwd,
      ...overrides,
    });
  }
  return { cwd, git, commit, notes };
}

function published(tag_name, extra = {}) {
  return { tag_name, draft: false, prerelease: false, ...extra };
}

test("first release lists the entire history with full commit links and managed boundaries", (t) => {
  const repo = fixture(t);
  const first = repo.commit("init: the Lindvimera awakens", "0.1.0");
  const notes = repo.notes("0.1.0", ["0.1.0"]);
  assert.equal(notes.baseTag, null);
  assert.deepEqual(notes.commits, [{ sha: first, subject: "init: the Lindvimera awakens" }]);
  assert.ok(notes.markdown.startsWith(`${NOTES_START}\n## Changes\n\n`));
  assert.ok(notes.markdown.endsWith(`${NOTES_END}\n`));
  assert.ok(notes.markdown.includes(`https://github.com/owner/project/commit/${first}`));
  assert.ok(!notes.markdown.includes("/compare/"));
  assert.ok(!notes.markdown.includes("Verified main CI"));
  assert.ok(!notes.markdown.includes("Lindvimera 0.1.0"));
});

test("usual release includes maintenance and version commits in oldest-first order", (t) => {
  const repo = fixture(t);
  repo.commit("init", "0.1.0");
  repo.commit("chore: improve plugin health and review readiness");
  repo.commit("feat: expand Vim editing, note navigation, and Ex commands");
  repo.commit("v0.2.0", "0.2.0");
  const notes = repo.notes("0.2.0", ["0.2.0", "0.1.0"]);
  assert.equal(notes.baseTag, "0.1.0");
  assert.deepEqual(
    notes.commits.map(({ subject }) => subject),
    [
      "chore: improve plugin health and review readiness",
      "feat: expand Vim editing, note navigation, and Ex commands",
      "v0.2.0",
    ],
  );
  assert.ok(
    notes.markdown.includes(
      "**Full Changelog:** [0.1.0 → 0.2.0](https://github.com/owner/project/compare/0.1.0...0.2.0)",
    ),
  );
});

test("selects the greatest numeric version instead of string or publication order", (t) => {
  const repo = fixture(t);
  repo.commit("base", "0.9.0");
  repo.commit("ten", "0.10.0");
  repo.commit("eleven", "0.11.0");
  assert.equal(repo.notes("0.11.0", ["0.10.0", "0.9.0"]).baseTag, "0.10.0");
  assert.equal(compareVersions("100000000000000000000.0.0", "99999999999999999999.0.0"), 1);
});

test("ignores non-ancestral versions, drafts, prereleases, later tags and nonnumeric tags", (t) => {
  const repo = fixture(t);
  repo.commit("base", "0.1.0");
  repo.git("checkout", "-b", "unrelated");
  repo.commit("other branch", "0.9.0");
  repo.git("checkout", "main");
  repo.commit("target", "1.0.0");
  const notes = repo.notes("1.0.0", [
    "0.9.0",
    "0.1.0",
    "2.0.0",
    published("0.8.0", { draft: true }),
    published("0.7.0", { prerelease: true }),
    "v0.6.0",
  ]);
  assert.equal(notes.baseTag, "0.1.0");
  assert.deepEqual(
    notes.commits.map(({ subject }) => subject),
    ["target"],
  );
});

test("includes merge commits after their parents", (t) => {
  const repo = fixture(t);
  repo.commit("base", "0.1.0");
  repo.git("checkout", "-b", "feature");
  repo.commit("feature");
  repo.git("checkout", "main");
  repo.commit("main work");
  repo.git("merge", "--no-ff", "feature", "-m", "Merge feature");
  repo.git("tag", "0.2.0");
  const subjects = repo.notes("0.2.0", ["0.1.0"]).commits.map(({ subject }) => subject);
  assert.equal(subjects.length, 3);
  assert.ok(subjects.includes("feature"));
  assert.ok(subjects.includes("main work"));
  assert.equal(subjects.at(-1), "Merge feature");
});

test("escapes Markdown and HTML without executing or changing the original commit subject", (t) => {
  const repo = fixture(t);
  const subject = "fix: [link](https://bad.invalid) <script> & *bold* `code` \\ path | ~~strike~~";
  repo.commit(subject, "0.1.0");
  const notes = repo.notes("0.1.0", []);
  assert.equal(notes.commits[0].subject, subject);
  assert.ok(notes.markdown.includes("\\[link\\]\\(https://bad\\.invalid\\)"));
  assert.ok(notes.markdown.includes("&lt;script&gt; &amp; \\*bold\\* \\`code\\`"));
  assert.ok(notes.markdown.includes("\\\\ path \\| \\~\\~strike\\~\\~"));
});

test("same-commit version emits an empty-diff message and comparison link", (t) => {
  const repo = fixture(t);
  repo.commit("base", "0.1.0");
  repo.git("tag", "0.2.0");
  const notes = repo.notes("0.2.0", ["0.1.0"]);
  assert.equal(notes.commits.length, 0);
  assert.ok(notes.markdown.includes("No commit changes since the previous release."));
  assert.ok(notes.markdown.includes("/compare/0.1.0...0.2.0"));
});

test("missing prior release tags fail instead of silently falling back", (t) => {
  const repo = fixture(t);
  repo.commit("base", "0.5.0");
  repo.commit("target", "1.0.0");
  assert.throws(() => repo.notes("1.0.0", ["0.5.0", "0.1.0"]), /Git history is unavailable/);
});

test("rejects a tag moved away from the requested commit", (t) => {
  const repo = fixture(t);
  const first = repo.commit("base", "0.1.0");
  repo.commit("target", "0.2.0");
  assert.throws(() => repo.notes("0.2.0", [], { commit: first }), /does not match/);
});

test("rejects shallow history even if the current tag resolves", (t) => {
  const repo = fixture(t);
  repo.commit("first");
  repo.commit("second", "0.1.0");
  const shallow = join(repo.cwd, "shallow");
  repo.git("clone", "--depth=1", pathToFileURL(repo.cwd).href, shallow);
  assert.throws(() => repo.notes("0.1.0", [], { cwd: shallow }), /complete Git history/);
});

test("fetches all release pages and filters only published stable versions", () => {
  const calls = [];
  const releases = fetchPublishedReleases({
    repository: "owner/project",
    gh(args) {
      calls.push(args);
      return JSON.stringify([
        [published("1.0.0"), published("2.0.0", { draft: true })],
        [published("0.1.0"), published("3.0.0", { prerelease: true })],
      ]);
    },
  });
  assert.deepEqual(
    releases.map((release) => release.tag_name),
    ["1.0.0", "0.1.0"],
  );
  assert.deepEqual(calls, [
    ["api", "repos/owner/project/releases?per_page=100", "--paginate", "--slurp"],
  ]);
});

test("rejects malformed or duplicate release listings", () => {
  for (const value of [
    {},
    [published("1.0.0")],
    [[published("1.0.0"), published("1.0.0")]],
    [[{}]],
  ]) {
    assert.throws(() =>
      fetchPublishedReleases({ repository: "owner/project", gh: () => JSON.stringify(value) }),
    );
  }
});
