import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  fetchPublishedReleases,
  generateReleaseNotes,
  NOTES_END,
  NOTES_START,
  resolveReleaseTag,
  runGh,
  validateRepository,
} from "./notes.mjs";

/** Preserve hand-written prose and the exact provenance marker, including schema 1. */
export function updateReleaseBody({ body, tag, repository, markdown }) {
  if (typeof body !== "string") throw new Error("Release body must be text.");
  const startCount = body.split(NOTES_START).length - 1;
  const endCount = body.split(NOTES_END).length - 1;
  const markerCount = [...body.matchAll(/<!--\s*lindvimera-notes:/g)].length;
  if (
    markerCount !== startCount + endCount ||
    startCount > 1 ||
    endCount > 1 ||
    startCount !== endCount ||
    (startCount === 1 && body.indexOf(NOTES_END) < body.indexOf(NOTES_START))
  ) {
    throw new Error(`Release ${tag} has malformed or duplicate managed notes blocks.`);
  }
  const legacyVerification = `Verified main CI: https://github.com/${repository}/actions/runs/`;
  const retained = body
    .split(/\r?\n/)
    .filter(
      (line) =>
        line !== `Lindvimera ${tag}` &&
        !(
          line.startsWith(legacyVerification) && /^\d+$/.test(line.slice(legacyVerification.length))
        ),
    )
    .join("\n");
  const block = markdown.trimEnd();
  if (startCount === 1) {
    const start = retained.indexOf(NOTES_START);
    const end = retained.indexOf(NOTES_END) + NOTES_END.length;
    return `${retained.slice(0, start)}${block}${retained.slice(end)}`.trim();
  }
  return retained.trim() ? `${block}\n\n${retained.trim()}` : block;
}

function preservedMetadata(release) {
  const fields = [
    "id",
    "node_id",
    "url",
    "html_url",
    "tag_name",
    "target_commitish",
    "name",
    "draft",
    "prerelease",
    "immutable",
    "created_at",
    "published_at",
  ];
  const assetFields = [
    "id",
    "node_id",
    "name",
    "label",
    "size",
    "digest",
    "state",
    "content_type",
    "created_at",
    "updated_at",
    "browser_download_url",
  ];
  const metadata = Object.fromEntries(fields.map((field) => [field, release[field]]));
  if (!Array.isArray(release.assets)) throw new Error("Release assets are unavailable.");
  metadata.assets = release.assets
    .map((asset) => Object.fromEntries(assetFields.map((field) => [field, asset[field]])))
    .sort((a, b) => a.id - b.id);
  return metadata;
}

function requirePreserved(before, after, expectedBody) {
  if (
    JSON.stringify(preservedMetadata(before)) !== JSON.stringify(preservedMetadata(after)) ||
    (after.body ?? "") !== expectedBody
  ) {
    throw new Error(`Release ${before.tag_name} changed concurrently or failed verification.`);
  }
}

function requireOriginalCommit(release, commit) {
  const markers = [...(release.body ?? "").matchAll(/<!-- lindvimera-release:(.*?) -->/gs)];
  if (markers.length === 0) return;
  if (markers.length !== 1)
    throw new Error(`Release ${release.tag_name} has duplicate provenance.`);
  let provenance;
  try {
    provenance = JSON.parse(markers[0][1]);
  } catch {
    throw new Error(`Release ${release.tag_name} has malformed provenance.`);
  }
  if (
    [1, 2].includes(provenance?.schemaVersion) &&
    (typeof provenance.commit !== "string" ||
      provenance.commit.toLowerCase() !== commit.toLowerCase())
  ) {
    throw new Error(`Release ${release.tag_name} tag no longer matches its published provenance.`);
  }
}

/** Preview by default. The only external mutation with apply=true is PATCH {body}. */
export function backfillReleaseNotes({
  repository,
  cwd = process.cwd(),
  gh = runGh,
  apply = false,
  snapshotDirectory = resolve(cwd, ".release-gate", `notes-backfill-${Date.now()}`),
}) {
  validateRepository(repository);
  const releases = fetchPublishedReleases({ repository, gh }).sort((a, b) =>
    compareVersions(a.tag_name, b.tag_name),
  );
  const readRelease = (id) => JSON.parse(gh(["api", `repos/${repository}/releases/${id}`]));
  const plans = releases.map((release) => {
    if (!Number.isSafeInteger(release.id) || release.id <= 0) {
      throw new Error("Invalid release ID.");
    }
    const before = readRelease(release.id);
    if (
      before.id !== release.id ||
      before.tag_name !== release.tag_name ||
      before.draft !== false ||
      before.prerelease !== false
    ) {
      throw new Error(`Release ${release.tag_name} changed since it was listed.`);
    }
    preservedMetadata(before);
    const commit = resolveReleaseTag({ cwd, tag: release.tag_name });
    requireOriginalCommit(before, commit);
    const notes = generateReleaseNotes({
      repository,
      tag: release.tag_name,
      commit,
      releases,
      cwd,
    });
    const body = updateReleaseBody({
      body: before.body ?? "",
      tag: release.tag_name,
      repository,
      markdown: notes.markdown,
    });
    return { before, body, commits: notes.commits.length, changed: (before.body ?? "") !== body };
  });
  // Finish generating every version before the first write so missing history or
  // malformed legacy notes cannot produce a partially applied backfill.
  mkdirSync(snapshotDirectory, { recursive: true });
  for (const plan of plans) {
    const prefix = resolve(snapshotDirectory, `${plan.before.tag_name}-${plan.before.id}`);
    writeFileSync(`${prefix}.before.json`, `${JSON.stringify(plan.before, null, 2)}\n`, "utf8");
    writeFileSync(`${prefix}.proposed.md`, `${plan.body}\n`, "utf8");
  }
  for (const plan of plans) {
    let after = plan.before;
    if (apply) {
      const fresh = readRelease(plan.before.id);
      requirePreserved(plan.before, fresh, plan.before.body ?? "");
      if (plan.changed) {
        gh(
          [
            "api",
            `repos/${repository}/releases/${plan.before.id}`,
            "--method",
            "PATCH",
            "--input",
            "-",
          ],
          { input: JSON.stringify({ body: plan.body }) },
        );
      }
      after = readRelease(plan.before.id);
      requirePreserved(plan.before, after, plan.body);
      const prefix = resolve(snapshotDirectory, `${plan.before.tag_name}-${plan.before.id}`);
      writeFileSync(`${prefix}.after.json`, `${JSON.stringify(after, null, 2)}\n`, "utf8");
    }
  }
  return {
    applied: apply,
    snapshotDirectory,
    releases: plans.map((plan) => ({
      tag: plan.before.tag_name,
      id: plan.before.id,
      commits: plan.commits,
      changed: plan.changed,
      body: plan.body,
    })),
  };
}

function main() {
  const args = process.argv.slice(2);
  const options = { repository: process.env.GITHUB_REPOSITORY };
  while (args.length) {
    const arg = args.shift();
    if (arg === "--apply") options.apply = true;
    else if (["--repository", "--snapshot-directory"].includes(arg) && args.length > 0) {
      options[arg === "--repository" ? "repository" : "snapshotDirectory"] = resolveOption(
        arg,
        args.shift(),
      );
    } else {
      throw new Error(
        "Usage: node scripts/release/backfill-notes.mjs [--repository owner/repo] [--snapshot-directory path] [--apply]",
      );
    }
  }
  const result = backfillReleaseNotes(options);
  console.log(JSON.stringify(result, null, 2));
}

function resolveOption(arg, value) {
  return arg === "--snapshot-directory" ? resolve(value) : value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
