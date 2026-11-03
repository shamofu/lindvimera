import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRemovalFixture } from "./fixture.mjs";

const cleanInstall = process.argv.includes("--install");
const selected = process.argv.find((argument) => argument.startsWith("--engine="))?.slice(9);
if (selected && !["embedded", "builtin"].includes(selected)) throw new Error("Unknown engine.");
const report = [];
for (const survivor of selected ? [selected] : ["embedded", "builtin"]) {
  const fixture = createRemovalFixture({ survivor, copyDependencies: !cleanInstall });
  const result = {
    survivor,
    fixture,
    dependencies: cleanInstall ? "clean-install" : "copied-installed-snapshot",
    checks: [],
    sourceHash: JSON.parse(readFileSync(join(fixture, "engine-removal.json"), "utf8")).sourceHash,
  };
  report.push(result);
  const temporary = join(fixture, ".test-runtime/temp");
  mkdirSync(temporary, { recursive: true });
  const env = {
    ...process.env,
    TEMP: temporary,
    TMP: temporary,
    PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
  };
  const commands = [
    ...(cleanInstall ? [["install", "pnpm install --frozen-lockfile"]] : []),
    ["typecheck", "scripts/engines/check.mjs", "typecheck"],
    ["unit", "scripts/engines/check.mjs", "test", "--maxWorkers=1"],
    [
      "scripts",
      "--test",
      "test/audit-dependencies.test.mjs",
      "test/probe/*.test.mjs",
      "test/engines/*.test.mjs",
      "test/release/*.test.mjs",
    ],
    ["build", "esbuild.config.mjs"],
    ["harness", "scripts/probe/build.mjs"],
  ];
  for (const [name, file, ...args] of commands) {
    const output =
      name === "install"
        ? spawnSync(file, {
            cwd: fixture,
            shell: true,
            encoding: "utf8",
            env,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
          })
        : spawnSync(process.execPath, [file, ...args], {
            cwd: fixture,
            encoding: "utf8",
            env,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
          });
    writeFileSync(
      join(fixture, `${name}.log`),
      (output.stdout ?? "") + (output.stderr ?? "") + (output.error?.stack ?? ""),
    );
    result.checks.push({
      name,
      exitCode: output.status,
      passed: output.status === 0 && !output.error,
    });
    console.log(`${survivor}: ${name} ${output.status === 0 ? "passed" : "failed"} (${fixture})`);
    if (name === "install" && (output.status !== 0 || output.error)) break;
  }
  const metadata = join(fixture, ".test-runtime/build/production-metafile.json");
  if (existsSync(metadata))
    result.bundleInputs = Object.keys(JSON.parse(readFileSync(metadata, "utf8")).inputs);
  writeFileSync(join(fixture, "verification.json"), JSON.stringify(result, null, 2) + "\n");
}
console.log(
  JSON.stringify(
    report.map(({ bundleInputs, ...result }) => ({
      ...result,
      bundleInputs: bundleInputs?.length,
    })),
    null,
    2,
  ),
);
if (
  report.some(
    (result) =>
      result.checks.length < (cleanInstall ? 6 : 5) || result.checks.some((check) => !check.passed),
  )
)
  process.exitCode = 1;
