import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const severities = ["info", "low", "moderate", "high", "critical"];

/** Validate pnpm's complete report before applying the release severity policy. */
export function evaluateAuditResult(result) {
  if (result.error) throw new Error("Could not run pnpm audit.", { cause: result.error });
  if (result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`pnpm audit did not complete successfully (status ${result.status}).`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("pnpm audit did not return a valid JSON report.", { cause: error });
  }
  const vulnerabilities = report?.metadata?.vulnerabilities;
  if (
    report?.error ||
    !vulnerabilities ||
    typeof vulnerabilities !== "object" ||
    Array.isArray(vulnerabilities)
  ) {
    throw new Error("pnpm audit did not return vulnerability counts.");
  }
  const counts = {};
  for (const severity of severities) {
    const count = vulnerabilities[severity];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`pnpm audit returned an invalid ${severity} count.`);
    }
    counts[severity] = count;
  }
  if (result.status === 1 && severities.every((severity) => counts[severity] === 0)) {
    throw new Error("pnpm audit failed without reporting any vulnerabilities.");
  }
  return { report, counts, exitCode: counts.high > 0 || counts.critical > 0 ? 1 : 0 };
}

function main() {
  // The command is constant. A shell also resolves pnpm.cmd on Windows runners.
  const result = spawnSync("pnpm audit --json", {
    shell: true,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  try {
    const outcome = evaluateAuditResult(result);
    console.log(JSON.stringify(outcome.report, null, 2));
    console.log(
      `Dependency audit: ${outcome.counts.high} high, ${outcome.counts.critical} critical. High and critical advisories block the release.`,
    );
    process.exitCode = outcome.exitCode;
  } catch (error) {
    if (result.stderr) console.error(result.stderr.trim());
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
