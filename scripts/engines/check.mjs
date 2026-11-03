import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { availableEngines, prepareEngineSources, projectRoot } from "./build.mjs";

function run(file, args) {
  const result = spawnSync(process.execPath, [join(projectRoot, "node_modules", file), ...args], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await prepareEngineSources();
if (process.argv[2] === "typecheck") {
  if (availableEngines().includes("embedded")) {
    run("typescript/bin/tsc", ["-p", "tsconfig.vendor-core.json"]);
    run("typescript/bin/tsc", ["-p", "tsconfig.vendor.json"]);
  }
  run("typescript/bin/tsc", ["-p", "tsconfig.json"]);
} else if (process.argv[2] === "test") run("vitest/vitest.mjs", ["run", ...process.argv.slice(3)]);
else throw new Error("Expected typecheck or test.");
