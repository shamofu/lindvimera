import { copyFile, mkdir, writeFile, access, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { distributionDirectory, runtimeFiles } from "../distribution.mjs";
import { buildProbe, harnessId } from "./build.mjs";
import { hashRuntimeFiles, verifyRuntimeFiles } from "./artifact-identity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export async function prepareProbe({
  runtime = join(root, ".test-runtime"),
  offline = false,
  cleanInstall = false,
  executable = process.env.OBSIDIAN_EXECUTABLE ??
    join(process.env.LOCALAPPDATA ?? "", "Programs/Obsidian/Obsidian.exe"),
  archive = process.env.OBSIDIAN_ARCHIVE ??
    join(process.env.APPDATA ?? "", "obsidian/obsidian-1.13.7.asar"),
} = {}) {
  const profile = join(runtime, "profile");
  const vault = join(runtime, "Lindvimera Test Vault");
  const plugin = join(vault, ".obsidian", "plugins", "lindvimera");
  const harness = join(vault, ".obsidian", "plugins", harnessId);

  await access(executable);
  await access(archive);
  await mkdir(profile, { recursive: true });
  await mkdir(plugin, { recursive: true });
  const candidateHashes = await hashRuntimeFiles(distributionDirectory);
  for (const file of runtimeFiles) {
    const target = join(plugin, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(distributionDirectory, file), target);
  }
  const installedHashes = await verifyRuntimeFiles(candidateHashes, plugin);
  await buildProbe(harness);
  await copyFile(archive, join(profile, "obsidian-1.13.7.asar"));
  const config = {
    vaults: { "0000000000000017": { path: vault, ts: Date.now(), open: true } },
    updateDisabled: true,
  };
  await writeFile(join(profile, "obsidian.json"), JSON.stringify(config, null, 2));
  if (cleanInstall) await rm(join(plugin, "data.json"), { force: true });
  else
    await writeFile(
      join(plugin, "data.json"),
      JSON.stringify({
        enabled: true,
        escapeSequences: ["jj"],
        escapeTimeoutMs: 200,
      }),
    );
  const enabledPlugins = ["lindvimera"];
  if (!cleanInstall) enabledPlugins.push(harnessId);
  if (offline) {
    const offlinePlugin = join(vault, ".obsidian", "plugins", "lindvimera-offline-probe");
    await mkdir(offlinePlugin, { recursive: true });
    await writeFile(
      join(offlinePlugin, "manifest.json"),
      JSON.stringify({
        id: "lindvimera-offline-probe",
        name: "Lindvimera offline probe",
        version: "0.0.0",
        minAppVersion: "1.13.7",
        description: "Isolated test-only renderer network simulation.",
        author: "Lindvimera tests",
        isDesktopOnly: true,
      }),
    );
    await writeFile(
      join(offlinePlugin, "main.js"),
      `
const { Plugin } = require("obsidian");
module.exports = class extends Plugin {
  onload() {
    const marker = globalThis.__lindvimeraOfflineProbe = { active: true, attempts: [] };
    const originalFetch = globalThis.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const blocked = value => {
      const url = typeof value === "string" ? value : value && (value.url || String(value));
      if (!/^https?:/i.test(url || "")) return false;
      marker.attempts.push(url);
      return true;
    };
    globalThis.fetch = function(input, options) {
      if (blocked(input)) return Promise.reject(new TypeError("Offline renderer probe"));
      return originalFetch.call(this, input, options);
    };
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      if (blocked(url)) throw new TypeError("Offline renderer probe");
      return originalOpen.call(this, method, url, ...args);
    };
    this.register(() => {
      globalThis.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalOpen;
      marker.active = false;
    });
  }
};
`,
    );
    enabledPlugins.unshift("lindvimera-offline-probe");
  }
  await writeFile(
    join(vault, ".obsidian", "community-plugins.json"),
    JSON.stringify(enabledPlugins),
  );
  await writeFile(
    join(vault, ".obsidian", "app.json"),
    JSON.stringify({ vimMode: false, livePreview: true }),
  );
  // Absence means Obsidian's standard core-plugin defaults, including suggestions,
  // search and the command palette whose scopes compete with the editor.
  await rm(join(vault, ".obsidian", "core-plugins.json"), { force: true });
  const fixture = join(root, "test", "fixtures", "native-table.md");
  await copyFile(fixture, join(vault, "Native table.md"));
  return { executable, archive, profile, vault, runtime, plugin, candidateHashes, installedHashes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { executable, profile, vault } = await prepareProbe({
    offline: process.argv.includes("--offline"),
  });
  if (process.argv.includes("--prepare-only")) {
    console.log(`Prepared isolated vault: ${vault}`);
  } else {
    const child = spawn(executable, [`--user-data-dir=${profile}`], {
      detached: true,
      stdio: "ignore",
      // Native editor verification uses a visible, interactive test window.
      windowsHide: false,
    });
    child.on("error", (error) => {
      console.error(error);
      process.exitCode = 1;
    });
    child.unref();
    console.log(`Launched isolated Obsidian probe, pid=${child.pid}, vault=${vault}`);
  }
}
