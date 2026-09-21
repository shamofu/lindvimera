import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NOTES_START = "<!-- lindvimera-notes:start -->";
export const NOTES_END = "<!-- lindvimera-notes:end -->";
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function validateRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("A valid owner/repository is required.");
  }
  return repository;
}

export function compareVersions(left, right) {
  if (!versionPattern.test(left) || !versionPattern.test(right)) {
    throw new Error("Release tags must use the numeric X.Y.Z format.");
  }
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function runGh(args, { input } = {}) {
  const result = spawnSync("gh", args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `GitHub CLI failed: ${result.stderr || result.error?.message || result.status}`,
    );
  }
  return result.stdout;
}

export function fetchPublishedReleases({ repository, gh = runGh }) {
  validateRepository(repository);
  const pages = JSON.parse(
    gh(["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"]),
  );
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error("GitHub did not return paginated release lists.");
  }
  return publishedVersionReleases(pages.flat());
}

export function publishedVersionReleases(releases) {
  if (
    !Array.isArray(releases) ||
    releases.some(
      (release) =>
        !release ||
        typeof release.tag_name !== "string" ||
        typeof release.draft !== "boolean" ||
        typeof release.prerelease !== "boolean",
    )
  ) {
    throw new Error("Invalid GitHub release metadata.");
  }
  const published = releases.filter(
    (release) => !release.draft && !release.prerelease && versionPattern.test(release.tag_name),
  );
  if (new Set(published.map((release) => release.tag_name)).size !== published.length) {
    throw new Error("Duplicate published release tags.");
  }
  return published;
}

function git(cwd, args, allowedStatuses = [0]) {
  const result = spawnSync("git", ["--no-replace-objects", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.signal || !allowedStatuses.includes(result.status)) {
    throw new Error(`Git history is unavailable: ${result.stderr || result.error?.message}`);
  }
  return result;
}

export function resolveReleaseTag({ cwd = process.cwd(), tag }) {
  if (!versionPattern.test(tag)) throw new Error("Release tags must use the numeric X.Y.Z format.");
  return git(cwd, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]).stdout.trim();
}

export function escapeMarkdownSubject(subject) {
  return subject
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}

/** Use complete Git ancestry and published stable versions, never artifact/CI history. */
export function generateReleaseNotes({ repository, tag, commit, releases, cwd = process.cwd() }) {
  validateRepository(repository);
  if (!/^[a-f0-9]{40}$/i.test(commit ?? "")) throw new Error("A full commit SHA is required.");
  if (git(cwd, ["rev-parse", "--is-shallow-repository"]).stdout.trim() !== "false") {
    throw new Error("Release notes require complete Git history (fetch-depth: 0).");
  }
  if (resolveReleaseTag({ cwd, tag }).toLowerCase() !== commit.toLowerCase()) {
    throw new Error(`Tag ${tag} does not match the requested commit.`);
  }
  const candidates = publishedVersionReleases(releases)
    .filter((release) => compareVersions(release.tag_name, tag) < 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  // Resolve every candidate before selecting a base: a missing higher/lower tag must
  // never silently turn an incomplete checkout into different release notes.
  const resolved = candidates.map((release) => ({
    tag: release.tag_name,
    commit: resolveReleaseTag({ cwd, tag: release.tag_name }),
  }));
  const base = resolved.find(
    (candidate) =>
      git(cwd, ["merge-base", "--is-ancestor", candidate.commit, commit], [0, 1]).status === 0,
  );
  const revision = base ? `${base.commit}..${commit}` : commit;
  const raw = git(cwd, [
    "log",
    "--reverse",
    "--topo-order",
    "--format=%H%x00%s%x00",
    revision,
  ]).stdout;
  const fields = raw.split("\0");
  const commits = [];
  for (let index = 0; index < fields.length - 1; index += 2) {
    const sha = fields[index].trim();
    if (!/^[a-f0-9]{40}$/.test(sha) || fields[index + 1] === undefined) {
      throw new Error("Git returned malformed commit history.");
    }
    commits.push({ sha, subject: fields[index + 1] });
  }
  const lines = [NOTES_START, "## Changes", ""];
  if (commits.length === 0) {
    lines.push("No commit changes since the previous release.");
  } else {
    lines.push(
      ...commits.map(
        ({ sha, subject }) =>
          `- ${escapeMarkdownSubject(subject)} ([${sha.slice(0, 7)}](https://github.com/${repository}/commit/${sha}))`,
      ),
    );
  }
  if (base) {
    lines.push(
      "",
      `**Full Changelog:** [${base.tag} → ${tag}](https://github.com/${repository}/compare/${base.tag}...${tag})`,
    );
  }
  lines.push(NOTES_END, "");
  return { markdown: lines.join("\n"), baseTag: base?.tag ?? null, commits };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output") {
    throw new Error("Usage: node scripts/release/notes.mjs --output <path>");
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const notes = generateReleaseNotes({
    repository,
    tag: process.env.GITHUB_REF_NAME,
    commit: process.env.GITHUB_SHA,
    releases: fetchPublishedReleases({ repository }),
  });
  const output = resolve(args[1]);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, notes.markdown, "utf8");
  console.log(`Generated ${notes.commits.length} release notes entries in ${output}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
