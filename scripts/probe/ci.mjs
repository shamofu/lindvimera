import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { prepareProbe } from "./run.mjs";
import { keyboardChecks, runKeyboardRegression } from "./keyboard-regression.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execute = promisify(execFile);
const results = join(root, ".test-runtime", "results");
const reportFiles = {
  "Lindvimera acceptance.json": "acceptance.json",
  "Lindvimera performance.json": "performance.json",
  "Lindvimera input diagnostics.json": "input-diagnostics.json",
};
const screenshots = ["ready.png", "table.png", "finished.png", "failure.png"];

async function bounded(promise, timeoutMs, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(getValue, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await getValue();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

async function sendOsKeys(processId, rootProcessId, profile, sequence = "jj") {
  const { stdout } = await execute(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      join(root, "scripts", "probe", "send-input.ps1"),
      "-TargetProcessId",
      String(processId),
      "-RootProcessId",
      String(rootProcessId),
      "-ExpectedProfile",
      profile,
      "-Sequence",
      sequence,
    ],
    { windowsHide: true, timeout: 30_000 },
  );
  console.log(stdout.trim());
}

async function stopApplication(child, browser) {
  if (!child?.pid) return;
  if (browser) {
    await bounded(
      browser
        .newBrowserCDPSession()
        .then((session) => session.send("Browser.close"))
        .catch(() => {}),
      5_000,
      "closing the isolated Obsidian instance",
    ).catch(() => {});
  }
  if (child.exitCode === null && child.signalCode === null) {
    await bounded(new Promise((done) => child.once("exit", done)), 3_000, "Obsidian exit").catch(
      () => {},
    );
  }
  if (child.exitCode === null && child.signalCode === null) {
    // Kill only the process tree created by this invocation, never other Obsidian windows.
    await execute("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000,
    }).catch(() => {});
  }
  await browser?.close().catch(() => {});
}

export async function runCiProbe() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("The existing E2E contract requires Windows x64 / Obsidian 1.13.7.");
  await mkdir(results, { recursive: true });
  for (const name of [
    ...Object.values(reportFiles),
    ...screenshots,
    "renderer.log",
    "keyboard-regression.json",
  ])
    await rm(join(results, name), { force: true });
  const runtime = join(root, ".test-runtime", "runs", randomUUID());
  const log = [];
  let environment;
  let child;
  let browser;
  let page;
  let stdout;
  let stderr;
  try {
    environment = await prepareProbe({ runtime, offline: true, cleanInstall: true });
    stdout = createWriteStream(join(results, "obsidian-stdout.log"));
    stderr = createWriteStream(join(results, "obsidian-stderr.log"));
    let debuggerOutput = "";
    child = spawn(
      environment.executable,
      [
        `--user-data-dir=${environment.profile}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-gpu",
        "--window-size=1280,960",
      ],
      // OS input needs a visible application window; helper processes remain hidden.
      { windowsHide: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (data) => stdout.write(data));
    child.stderr.on("data", (data) => {
      stderr.write(data);
      debuggerOutput = `${debuggerOutput}${data}`.slice(-64_000);
    });
    await new Promise((started, reject) => {
      child.once("spawn", started);
      child.once("error", reject);
    });
    const endpoint = await waitFor(
      async () => {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Obsidian exited before CDP was ready (${child.exitCode}).`);
        const announced = debuggerOutput.match(
          /DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/,
        );
        if (announced) return announced[1];
        try {
          const [port, path] = (
            await readFile(join(environment.profile, "DevToolsActivePort"), "utf8")
          )
            .trim()
            .split(/\r?\n/);
          if (/^\d+$/.test(port) && path?.startsWith("/devtools/browser/"))
            return `ws://127.0.0.1:${port}${path}`;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      },
      60_000,
      "Obsidian CDP endpoint",
    );
    browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 });
    page = await waitFor(
      () =>
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((candidate) => candidate.url().startsWith("app://obsidian.md/")),
      60_000,
      "Obsidian Vault window",
    );
    page.setDefaultTimeout(30_000);
    page.on("console", (message) =>
      log.push(`${new Date().toISOString()} ${message.type()} ${message.text()}`),
    );
    page.on("pageerror", (error) =>
      log.push(`${new Date().toISOString()} pageerror ${error.stack}`),
    );
    // This profile and Vault were just created above and contain only our test plugins.
    const trust = page.getByRole("button", {
      name: /^(Trust author and enable plugins|作成者を信頼しプラグインを有効化)$/,
    });
    await Promise.race([
      trust.waitFor({ state: "visible", timeout: 90_000 }),
      page.waitForFunction(() => globalThis.app?.plugins?.plugins?.lindvimera, undefined, {
        timeout: 90_000,
      }),
    ]);
    const trustClicked = await trust.isVisible();
    if (trustClicked) await trust.click();
    await page.waitForFunction(() => globalThis.app?.plugins?.plugins?.lindvimera, undefined, {
      timeout: 90_000,
    });
    // Plugin trust opens Settings after loading the plugin. Close that foreground
    // scope before checking an ordinary clean-install editor.
    if (trustClicked)
      await page.waitForFunction(() => globalThis.app.setting.modalEl.isConnected, undefined, {
        timeout: 30_000,
      });
    await bounded(
      page.evaluate(() => globalThis.app.plugins.plugins.lindvimera.wordsReady),
      90_000,
      "bundled dictionary initialization",
    );
    await page.evaluate(() => globalThis.app.setting.close());
    const system = await browser.newBrowserCDPSession();
    const { processInfo } = await system.send("SystemInfo.getProcessInfo");
    await system.detach();
    const applicationPid = processInfo.find((info) => info.type === "browser")?.id;
    if (!Number.isInteger(applicationPid) || applicationPid <= 0)
      throw new Error("CDP did not identify the isolated Obsidian browser process.");
    const keyboardResults = await runKeyboardRegression(page, async () => {
      await page.bringToFront();
      await sendOsKeys(applicationPid, child.pid, environment.profile, "escape");
    });
    await writeFile(
      join(results, "keyboard-regression.json"),
      JSON.stringify(keyboardResults, null, 2),
    );
    // Only after testing production defaults do we opt into the separate regression
    // workbench and its explicit jj configuration. No data.json existed at startup.
    await page.evaluate(async () => {
      const app = globalThis.app;
      const plugin = app.plugins.plugins.lindvimera;
      Object.assign(plugin.settings, {
        probeEnabled: true,
        escapeSequences: ["jj"],
        escapeTimeoutMs: 200,
      });
      await plugin.saveSettings();
      await app.plugins.unloadPlugin("lindvimera");
      await app.plugins.loadPlugin("lindvimera");
    });
    await page.waitForFunction(
      () => globalThis.app.workspace.getLeavesOfType("lindvimera-input-probe")[0]?.view,
      undefined,
      { timeout: 90_000 },
    );
    await page.locator(".lindvimera-probe .probe-editor").waitFor({ state: "visible" });
    await bounded(
      page.evaluate(() => globalThis.app.plugins.plugins.lindvimera.wordsReady),
      90_000,
      "reloaded workbench dictionary initialization",
    );
    await page.evaluate(async (checks) => {
      await globalThis.app.workspace
        .getLeavesOfType("lindvimera-input-probe")[0]
        .view.recordKeyboardRegression(checks);
    }, keyboardResults);
    await page.screenshot({ path: join(results, "ready.png") });
    const runSuite = async (method) => {
      console.log(`Obsidian E2E: ${method}`);
      await bounded(
        page.evaluate(async (name) => {
          const probe = globalThis.app.workspace.getLeavesOfType("lindvimera-input-probe")[0].view;
          await probe[name]();
        }, method),
        180_000,
        method,
      );
    };
    await runSuite("runEngineRegression");
    await page.evaluate(async () => {
      const app = globalThis.app;
      const probe = app.workspace.getLeavesOfType("lindvimera-input-probe")[0];
      await app.workspace.revealLeaf(probe);
      const leaf = app.workspace.getLeaf("split", "vertical");
      const file = app.vault.getAbstractFileByPath("Native table.md");
      await leaf.openFile(file, { state: { mode: "source", source: false } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
    });
    await page.getByRole("cell", { name: "日本語", exact: true }).click();
    await page.waitForFunction(() =>
      globalThis.app.workspace
        .getLeavesOfType("markdown")
        .some(
          (leaf) => leaf.view.file?.path === "Native table.md" && leaf.view.editMode?.tableCell,
        ),
    );
    await page.screenshot({ path: join(results, "table.png") });
    await runSuite("runNativeRegression");
    await runSuite("runHostRegression");
    await runSuite("preparePhysicalInput");
    await page.bringToFront();
    await page.locator(".lindvimera-probe .probe-editor .cm-content").focus();
    await sendOsKeys(applicationPid, child.pid, environment.profile);
    await page.waitForFunction(
      () =>
        globalThis.app.workspace
          .getLeavesOfType("lindvimera-input-probe")[0]
          .view.getPhysicalInputCount() === 6,
      undefined,
      { timeout: 10_000 },
    );
    await runSuite("verifyPhysicalInput");
    const report = JSON.parse(
      await readFile(join(environment.vault, "Lindvimera acceptance.json"), "utf8"),
    );
    const manifest = JSON.parse(
      await readFile(join(environment.vault, ".obsidian/plugins/lindvimera/manifest.json"), "utf8"),
    );
    assert.equal(report.schemaVersion, 3);
    assert.equal(report.behavior, "cell-editor-v1");
    assert.equal(report.scope, "non-ime");
    assert.equal(report.environment?.obsidian, "1.13.7");
    assert.equal(report.environment?.platform, "win32");
    assert.equal(report.environment?.plugin, manifest.version);
    const required = [
      ...keyboardChecks,
      "ascii-escape-recording",
      "macro-independent-of-escape-setting",
      "body-change-single-undo",
      "word-punctuation-stops",
      "word-objects-vim-parity",
      "lindera-mode-editing",
      "budoux-markdown-surround",
      "native-table-compatibility",
      "native-cell-line-delete-undo-redo",
      "native-cell-rectangle-delete",
      "native-cell-line-paste",
      "native-cell-change-escape-undo",
      "native-cell-insert-move-undo",
      "native-cell-lindera-modes",
      "native-cell-motions-and-session",
      "native-cell-cursor-and-search",
      "native-explicit-cell-navigation",
      "native-insert-host-navigation",
      "native-cell-open-line",
      "native-keyboard-macro-and-escape",
      "native-cell-dot-and-named-register",
      "native-cell-character-paste-and-surround",
      "native-table-entry-exit",
      "native-fixture-restored",
      "host-source-live-preview",
      "host-split-panes",
      "host-keymap-settings",
      "host-disable-enable",
      "host-built-in-guard",
      "host-external-edit",
      "host-hotkey-precedence",
      "host-body-insert-move-undo",
      "host-lindera-modes-and-switching",
      "host-gf-unsaved-links",
      "large-note-performance",
      "physical-keyboard-input",
      "offline-local-assets",
    ];
    const failed = required.filter((name) => report.checks?.[name]?.passed !== true);
    for (const name of failed)
      console.error(`${name}: ${report.checks?.[name]?.detail ?? "Not run"}`);
    assert.equal(failed.length, 0, `Real application checks have not passed: ${failed.join(", ")}`);
    await page.screenshot({ path: join(results, "finished.png") });
    console.log("All existing non-IME Obsidian E2E checks passed, including Windows OS input.");
  } catch (error) {
    await page?.screenshot({ path: join(results, "failure.png"), timeout: 5_000 }).catch(() => {});
    throw error;
  } finally {
    await stopApplication(child, browser);
    stdout?.end();
    stderr?.end();
    if (environment) {
      for (const [source, destination] of Object.entries(reportFiles)) {
        await copyFile(join(environment.vault, source), join(results, destination)).catch(
          (error) => {
            if (error.code !== "ENOENT") throw error;
          },
        );
      }
    }
    await writeFile(join(results, "renderer.log"), `${log.join("\n")}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCiProbe().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
