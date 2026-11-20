import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { prepareProbe } from "./run.mjs";
import { verifyRuntimeFiles } from "./artifact-identity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function waitFor(get, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await get();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function runBuiltinProbe() {
  const run = join(root, ".test-runtime", "runs", `builtin-${randomUUID()}`);
  const results = join(root, ".test-runtime", "builtin-115-results.json");
  await mkdir(run, { recursive: true });
  const checks = {};
  const log = [];
  const rendererErrors = [];
  let child, browser, environment;
  try {
    environment = await prepareProbe({
      runtime: run,
      offline: true,
      cleanInstall: false,
      engine: "builtin",
      harness: false,
      archive:
        process.env.OBSIDIAN_ARCHIVE ??
        join(process.env.LOCALAPPDATA, "Programs/Obsidian/resources/obsidian.asar"),
    });
    child = spawn(
      environment.executable,
      [
        `--user-data-dir=${environment.profile}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-gpu",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stdout.on("data", (data) => log.push(String(data)));
    child.stderr.on("data", (data) => {
      stderr += data;
      log.push(String(data));
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const endpoint = await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Isolated Obsidian exited ${child.exitCode}`);
      const announced = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/u);
      if (announced) return announced[1];
      try {
        const [port, suffix] = (
          await readFile(join(environment.profile, "DevToolsActivePort"), "utf8")
        )
          .trim()
          .split(/\r?\n/u);
        if (port && suffix) return `ws://127.0.0.1:${port}${suffix}`;
      } catch {}
    }, "isolated CDP");
    browser = await chromium.connectOverCDP(endpoint);
    const page = await waitFor(
      () =>
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((page) => page.url().startsWith("app://obsidian.md/")),
      "Vault window",
    );
    page.on("pageerror", (error) => {
      log.push(error.stack);
      rendererErrors.push(error.stack);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        log.push(message.text());
        rendererErrors.push(message.text());
      }
    });
    const trust = page.getByRole("button", {
      name: /^(Trust author and enable plugins|作成者を信頼しプラグインを有効化)$/u,
    });
    await Promise.race([
      trust.waitFor({ state: "visible", timeout: 90000 }),
      page.waitForFunction(() => globalThis.app?.plugins?.plugins?.lindvimera, undefined, {
        timeout: 90000,
      }),
    ]);
    if (await trust.isVisible()) await trust.click();
    await page.waitForFunction(
      () => globalThis.app?.plugins?.plugins?.lindvimera?.runtime?.backend,
      undefined,
      { timeout: 90000 },
    );
    await page.evaluate(async () => {
      await app.plugins.plugins.lindvimera.wordsReady;
      app.setting.close();
    });
    let serial = 0;
    const setup = async (text, source = true) => {
      await page.keyboard.press("Escape");
      await page.evaluate(
        async ({ text, source, path }) => {
          app.setting.close();
          const leaf = globalThis.__builtin115?.leaf ?? app.workspace.getLeaf("tab");
          const file = await app.vault.create(path, text);
          await leaf.openFile(file, { state: { mode: "source", source } });
          app.workspace.setActiveLeaf(leaf, { focus: true });
          globalThis.__builtin115 = { leaf };
        },
        { text, source, path: `Builtin ${++serial}.md` },
      );
      await page.waitForFunction(() => {
        const view = __builtin115.leaf.view.editMode?.cm;
        return (
          view?.cm?.state.vim && app.plugins.plugins.lindvimera.runtime.backend.editorSession(view)
        );
      });
      await page.evaluate(() => {
        const view = __builtin115.leaf.view.editMode.cm;
        view.cm.setCursor({ line: 0, ch: 0 });
        view.focus();
      });
    };
    const snapshot = () =>
      page.evaluate(() => {
        const view = __builtin115.leaf.view.editMode.cm,
          cm = view.cm;
        return {
          text: view.state.doc.toString(),
          cursor: cm.getCursor(),
          insert: !!cm.state.vim.insertMode,
          visual: !!cm.state.vim.visualMode,
          sel: cm.state.vim.sel,
          selection: view.state.selection.ranges.map((range) => ({
            anchor: range.anchor,
            head: range.head,
          })),
          input: {
            operator: cm.state.vim.inputState.operator,
            keys: cm.state.vim.inputState.keyBuffer,
          },
          dialog: cm.state.dialog?.textContent,
          dialogInput: !!cm.state.dialog?.querySelector?.("input"),
          status: app.plugins.plugins.lindvimera.runtime.backend.status(),
        };
      });
    const keys = async (sequence) => {
      for (const key of sequence.match(/<[^>]+>|./gu) ?? [])
        await page.keyboard.press(
          { "<Esc>": "Escape", "<CR>": "Enter", "<Tab>": "Tab", "<S-Tab>": "Shift+Tab" }[key] ??
            key.replace(/^<C-(.)>$/u, "Control+$1"),
        );
    };
    const check = async (name, action) => {
      try {
        await action();
        checks[name] = { passed: true };
      } catch (error) {
        checks[name] = {
          passed: false,
          error: error.stack,
          observed: await snapshot().catch(() => null),
        };
      }
      console.log(`builtin ${name}: ${checks[name].passed ? "PASS" : "FAIL"}`);
    };

    await setup("alpha beta gamma\n");
    await check("actual-native-identity", async () => {
      const identity = await page.evaluate(() => {
        const plugin = app.plugins.plugins.lindvimera,
          runtime = plugin.runtime,
          view = __builtin115.leaf.view.editMode.cm;
        return {
          version: runtime.version,
          engine: runtime.engine,
          native: runtime.backend.Vim === window.CodeMirrorAdapter.Vim,
          legacy: runtime.backend.Vim === window.CodeMirror.Vim,
          cm: runtime.backend.getCM(view) === view.cm && view.cm.cm6 === view,
          session: runtime.backend.editorSession(view).cm === view.cm,
          appVersion: app.getVersion?.(),
        };
      });
      assert.equal(identity.version, 2);
      assert.equal(identity.engine.active, "builtin");
      assert.equal(identity.native, true);
      assert.equal(identity.legacy, false);
      assert.equal(identity.cm, true);
      assert.equal(identity.session, true);
      checks.identity = identity;
    });
    await check("native-delete-dot-undo", async () => {
      await setup("one two three four");
      await keys("dw.");
      assert.equal((await snapshot()).text, "three four");
      await keys("u");
      assert.equal((await snapshot()).text, "two three four");
    });
    await check("native-macro", async () => {
      await setup("one two three four");
      await keys("qadwq@a");
      assert.equal((await snapshot()).text, "three four");
      await setup("abcdefg");
      await keys("qaxq");
      await setup("abcdefg");
      await page.evaluate(() => {
        const register = CodeMirrorAdapter.Vim.getRegisterController().getRegister("a");
        globalThis.__builtin115.registerIdentity = {
          register,
          keys: register.keyBuffer,
          inserts: register.insertModeChanges,
          searches: register.searchQueries,
        };
      });
      await keys("2@a@@");
      assert.equal((await snapshot()).text, "defg");
      assert.equal(
        await page.evaluate(() => {
          const before = __builtin115.registerIdentity;
          const register = CodeMirrorAdapter.Vim.getRegisterController().getRegister("a");
          return (
            register === before.register &&
            register.keyBuffer === before.keys &&
            register.insertModeChanges === before.inserts &&
            register.searchQueries === before.searches
          );
        }),
        true,
      );
    });
    await check("japanese-grapheme-motion-and-operator", async () => {
      await setup("か\u3099😀 next");
      await keys("l");
      assert.equal((await snapshot()).cursor.ch, 2);
      await keys("0dl");
      assert.equal((await snapshot()).text, "😀 next");
    });
    await check("japanese-word-motion-and-dot", async () => {
      await setup("東京都に行きます。大阪府に行きます。");
      const expected = await page.evaluate(() => {
        const plugin = app.plugins.plugins.lindvimera;
        return plugin.wordSegmenter().segment("東京都に行きます。大阪府に行きます。")[0].to;
      });
      await keys("w");
      assert.equal((await snapshot()).cursor.ch, expected);
      await keys("0dw.");
      assert.ok((await snapshot()).text.length < 19);
    });
    await check("surround-add-dot-delete-cancel", async () => {
      await setup("one two three");
      await keys("ysiw)");
      assert.equal((await snapshot()).text, "(one) two three");
      await keys("3w.");
      assert.equal((await snapshot()).text, "(one) (two) three");
      await keys("ds)");
      assert.equal((await snapshot()).text, "(one) two three");
      await keys("ysiw<Esc>");
      assert.equal((await snapshot()).text, "(one) two three");
    });
    await check("markdown-text-object", async () => {
      await setup("**alpha** beta");
      await keys("di*");
      assert.equal((await snapshot()).text, "**** beta");
    });
    await check("markdown-content-start-and-insert", async () => {
      await setup("- [ ] body");
      await keys("^");
      assert.equal((await snapshot()).cursor.ch, 6);
      await keys("I");
      assert.equal((await snapshot()).cursor.ch, 6);
      assert.equal((await snapshot()).insert, true);
      await keys("<Esc>");
    });
    await check("native-ex-js-capture", async () => {
      await setup("ab ab");
      await page.evaluate(() => {
        const view = __builtin115.leaf.view.editMode.cm;
        CodeMirrorAdapter.Vim.handleEx(view.cm, "%s/(a)(b)/$2$1/g");
      });
      assert.equal((await snapshot()).text, "ba ba");
    });
    await check("native-ex-js-dollar-and-unmatched-group", async () => {
      await setup("ab");
      await page.evaluate(() =>
        CodeMirrorAdapter.Vim.handleEx(
          __builtin115.leaf.view.editMode.cm.cm,
          "%s/(a)(b)/$$-$&-$2$1-$99/",
        ),
      );
      assert.equal((await snapshot()).text, "$-ab-ba-$99");
      await setup("b");
      await page.evaluate(() =>
        CodeMirrorAdapter.Vim.handleEx(__builtin115.leaf.view.editMode.cm.cm, "%s/(a)?b/$1/"),
      );
      assert.equal((await snapshot()).text, "");
    });
    await check("native-ex-confirm-cancel-and-undo", async () => {
      await setup("a a");
      await page.evaluate(() =>
        CodeMirrorAdapter.Vim.handleEx(__builtin115.leaf.view.editMode.cm.cm, "%s/a/A/gc"),
      );
      await keys("yy");
      assert.equal((await snapshot()).text, "A A");
      await keys("u");
      assert.equal((await snapshot()).text, "a a");
      await page.evaluate(() =>
        CodeMirrorAdapter.Vim.handleEx(__builtin115.leaf.view.editMode.cm.cm, "%s/a/A/gc"),
      );
      await keys("<Esc>");
      assert.equal((await snapshot()).text, "a a");
    });
    await check("native-ex-mapping-confirm-continuation", async () => {
      await page.evaluate(async () => {
        const plugin = app.plugins.plugins.lindvimera;
        plugin.settings.keyBindings = [{ mode: "normal", from: "Q", to: ":s/a/A/gc<CR>j" }];
        await plugin.saveSettings();
      });
      await setup("a a\nsecond");
      await keys("Q");
      await page.waitForFunction(() => __builtin115.leaf.view.editMode.cm.cm.state.dialog);
      assert.equal((await snapshot()).cursor.line, 0);
      await keys("yy");
      await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
      assert.equal((await snapshot()).text, "A A\nsecond");
      assert.equal((await snapshot()).cursor.line, 1);
      await keys("u");
      assert.equal((await snapshot()).text, "a a\nsecond");
      await setup("a a\nsecond");
      await keys("Q");
      await page.waitForFunction(() => __builtin115.leaf.view.editMode.cm.cm.state.dialog);
      await keys("<Esc>");
      await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
      assert.equal((await snapshot()).text, "a a\nsecond");
      assert.equal((await snapshot()).cursor.line, 1);
      await page.evaluate(async () => {
        const plugin = app.plugins.plugins.lindvimera;
        plugin.settings.keyBindings = [];
        await plugin.saveSettings();
      });
    });
    for (const mapped of [false, true]) {
      for (const cancel of ["q", "<Esc>", "<C-c>", "<C-[>"]) {
        await check(`native-ex-${mapped ? "mapped" : "raw"}-cancel-${cancel}`, async () => {
          await page.evaluate(async (mapped) => {
            const plugin = app.plugins.plugins.lindvimera;
            plugin.settings.keyBindings = mapped
              ? [{ mode: "normal", from: "Q", to: ":s/a/A/gc<CR>gg0rZ" }]
              : [];
            await plugin.saveSettings();
          }, mapped);
          try {
            await setup("a a\nsecond");
            if (mapped) await keys("Q");
            else
              await page.evaluate(() =>
                CodeMirrorAdapter.Vim.handleEx(__builtin115.leaf.view.editMode.cm.cm, "s/a/A/gc"),
              );
            await page.waitForFunction(() => __builtin115.leaf.view.editMode.cm.cm.state.dialog);
            await keys("y");
            assert.equal((await snapshot()).text, "A a\nsecond");
            await keys(cancel);
            await page.waitForFunction(() => !__builtin115.leaf.view.editMode.cm.cm.state.dialog);
            await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
            assert.equal((await snapshot()).text, mapped ? "Z a\nsecond" : "A a\nsecond");
            assert.equal((await snapshot()).cursor.line, 0);
            await keys("u");
            assert.equal((await snapshot()).text, "a a\nsecond");
          } finally {
            await page.evaluate(async () => {
              const plugin = app.plugins.plugins.lindvimera;
              plugin.settings.keyBindings = [];
              await plugin.saveSettings();
            });
          }
        });
      }
    }
    await check("native-ex-nested-confirmation-single-undo", async () => {
      await page.evaluate(async () => {
        const plugin = app.plugins.plugins.lindvimera;
        plugin.settings.keyBindings = [
          { mode: "normal", from: "Z", to: ":%s/a/A/gc<CR>:%s/A/X/gc<CR>" },
          { mode: "normal", from: "Q", to: "Zgg0rZ" },
        ];
        await plugin.saveSettings();
      });
      try {
        await setup("a a");
        await keys("Q");
        await page.waitForFunction(() => __builtin115.leaf.view.editMode.cm.cm.state.dialog);
        await keys("yq");
        await page.waitForFunction(() => __builtin115.leaf.view.editMode.cm.cm.state.dialog);
        await keys("y");
        await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
        assert.equal((await snapshot()).text, "Z a");
        await keys("u");
        assert.equal((await snapshot()).text, "a a");
      } finally {
        await page.evaluate(async () => {
          const plugin = app.plugins.plugins.lindvimera;
          plugin.settings.keyBindings = [];
          await plugin.saveSettings();
        });
      }
    });
    await check("native-ex-queued-macro-continuation", async () => {
      await page.evaluate(async () => {
        const plugin = app.plugins.plugins.lindvimera;
        plugin.settings.keyBindings = [{ mode: "normal", from: "Q", to: "l" }];
        await plugin.saveSettings();
      });
      try {
        await setup("a a\nsecond\nthird");
        await keys("qaQjq");
        await setup("a a\nsecond\nthird");
        await page.evaluate(async () => {
          const plugin = app.plugins.plugins.lindvimera;
          plugin.settings.keyBindings = [
            { mode: "normal", from: "Q", to: ":s/a/A/gc<CR>" },
            { mode: "normal", from: "E", to: ":s/a/a/<CR>@a" },
          ];
          await plugin.saveSettings();
        });
        await keys("E");
        await page.waitForFunction(() => __builtin115.leaf.view.editMode.cm.cm.state.dialog);
        assert.equal((await snapshot()).cursor.line, 0);
        await keys("yy");
        await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
        assert.equal((await snapshot()).text, "A A\nsecond\nthird");
        assert.equal((await snapshot()).cursor.line, 1);
      } finally {
        await page.evaluate(async () => {
          const plugin = app.plugins.plugins.lindvimera;
          plugin.settings.keyBindings = [];
          await plugin.saveSettings();
        });
      }
    });
    await check("native-ex-macro-insert-continuation", async () => {
      await page.evaluate(async () => {
        const plugin = app.plugins.plugins.lindvimera;
        plugin.settings.keyBindings = [{ mode: "normal", from: "Q", to: "l" }];
        await plugin.saveSettings();
      });
      try {
        await setup("a a");
        await keys("qaQiX<Esc>q");
        await page.evaluate(async () => {
          const plugin = app.plugins.plugins.lindvimera;
          plugin.settings.keyBindings = [{ mode: "normal", from: "Q", to: ":s/a/A/gc<CR>" }];
          await plugin.saveSettings();
        });
        await setup("a a");
        await keys("Q");
        await page.waitForFunction(() => __builtin115.leaf.view.editMode.cm.cm.state.dialog);
        await keys("yy");
        await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
        await keys("iX<Esc>");
        const expected = (await snapshot()).text;
        await setup("a a");
        await keys("@a");
        await page.waitForFunction(() => __builtin115.leaf.view.editMode.cm.cm.state.dialog);
        await keys("yy");
        await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
        assert.equal((await snapshot()).text, expected);
        assert.equal((await snapshot()).insert, false);
      } finally {
        await page.evaluate(async () => {
          const plugin = app.plugins.plugins.lindvimera;
          plugin.settings.keyBindings = [];
          await plugin.saveSettings();
        });
      }
    });
    await check("native-ex-macro-mapped-insert-phase", async () => {
      await page.evaluate(async () => {
        const plugin = app.plugins.plugins.lindvimera;
        plugin.settings.keyBindings = [{ mode: "normal", from: "Q", to: ":s/a/A/gc<CR>i" }];
        await plugin.saveSettings();
      });
      try {
        await setup("a a");
        await keys("qaQ");
        await page.waitForFunction(() => __builtin115.leaf.view.editMode.cm.cm.state.dialog);
        await keys("yy");
        await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
        await keys("X<Esc>q");
        const expected = (await snapshot()).text;
        await setup("a a");
        await keys("@a");
        await page.waitForFunction(() => __builtin115.leaf.view.editMode.cm.cm.state.dialog);
        await keys("yy");
        await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
        assert.equal((await snapshot()).text, expected);
        assert.equal((await snapshot()).insert, false);
      } finally {
        await page.evaluate(async () => {
          const plugin = app.plugins.plugins.lindvimera;
          plugin.settings.keyBindings = [];
          await plugin.saveSettings();
        });
      }
    });
    await check("native-ex-unsubmitted-input-cancel-continuation", async () => {
      try {
        for (const key of ["<Esc>", "<BS>", "<C-c>", "<C-[>"]) {
          await page.evaluate(async (key) => {
            const plugin = app.plugins.plugins.lindvimera;
            plugin.settings.keyBindings = [{ mode: "normal", from: "Q", to: `:${key}l` }];
            await plugin.saveSettings();
          }, key);
          await setup("abc");
          await keys("Q");
          await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
          assert.equal((await snapshot()).cursor.ch, 1, key);
          assert.equal(
            await page.evaluate(() => !!__builtin115.leaf.view.editMode.cm.cm.state.dialog),
            false,
            key,
          );
        }
        await page.evaluate(async () => {
          const plugin = app.plugins.plugins.lindvimera;
          plugin.settings.keyBindings = [{ mode: "normal", from: "Q", to: ":s/a/a/<CR>f:" }];
          await plugin.saveSettings();
        });
        await setup("a:b");
        await keys("Q");
        await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
        assert.equal((await snapshot()).cursor.ch, 1);
        assert.equal(
          await page.evaluate(
            () => !!__builtin115.leaf.view.editMode.cm.cm.state.dialog?.querySelector("input"),
          ),
          false,
        );
      } finally {
        await page.evaluate(async () => {
          const plugin = app.plugins.plugins.lindvimera;
          plugin.settings.keyBindings = [];
          await plugin.saveSettings();
        });
      }
    });
    await check("native-ex-mapping-count-and-visual-range", async () => {
      await page.evaluate(async () => {
        const plugin = app.plugins.plugins.lindvimera;
        plugin.settings.keyBindings = ["normal", "visual"].map((mode) => ({
          mode,
          from: "Q",
          to: ":s/a/A/g<CR>",
        }));
        await plugin.saveSettings();
      });
      await setup("a\na\na\na");
      await keys("3Q");
      await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
      assert.equal((await snapshot()).text, "A\nA\nA\na");
      await setup("a\na\na\na");
      await keys("VjQ");
      await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
      assert.equal((await snapshot()).text, "A\nA\na\na");
      await page.evaluate(async () => {
        const plugin = app.plugins.plugins.lindvimera;
        plugin.settings.keyBindings = [];
        await plugin.saveSettings();
      });
    });
    await check("native-visual-grapheme-text-object", async () => {
      await setup("か\u3099 次");
      await keys("v");
      const v = await snapshot();
      await keys("iw");
      checks.visualStages = { v, iw: await snapshot() };
      await keys("d");
      assert.equal((await snapshot()).text, " 次");
    });
    await check("japanese-word-search", async () => {
      await setup("東京都へ 東京都から");
      await keys("*");
      assert.equal((await snapshot()).cursor.ch, 5);
    });
    await check("native-smart-lists-on-off", async () => {
      await page.evaluate(() => app.vault.setConfig("smartIndentList", true));
      await setup("- [x] task");
      await keys("o");
      assert.equal((await snapshot()).text, "- [x] task\n- [ ] ");
      await keys("<Esc>");
      await page.evaluate(() => app.vault.setConfig("smartIndentList", false));
      await setup("- [x] task");
      await keys("o");
      assert.equal((await snapshot()).text, "- [x] task\n");
      await keys("<Esc>");
      await page.evaluate(() => app.vault.setConfig("smartIndentList", true));
    });
    await check("native-live-preview-column-independent-of-markdown-setting", async () => {
      await page.evaluate(async () => {
        const plugin = app.plugins.plugins.lindvimera;
        plugin.settings.markdownEditing = false;
        await plugin.saveSettings();
      });
      try {
        for (const source of [false, true]) {
          await setup("- one\n- [ ] two\nplain", source);
          await page.evaluate(() =>
            __builtin115.leaf.view.editMode.cm.cm.setCursor({ line: 0, ch: 3 }),
          );
          await keys("j");
          assert.equal((await snapshot()).cursor.ch, source ? 3 : 7);
        }
      } finally {
        await page.evaluate(async () => {
          const plugin = app.plugins.plugins.lindvimera;
          plugin.settings.markdownEditing = true;
          await plugin.saveSettings();
        });
      }
    });
    await check("markdown-open-above-and-dot", async () => {
      await setup("- first\n- second");
      await keys("OX<Esc>j.");
      assert.equal((await snapshot()).text, "- X\n- X\n- first\n- second");
    });
    await check("native-counted-open-lines", async () => {
      await setup("- item");
      await keys("3oX<Esc>");
      assert.equal((await snapshot()).text, "- item\n- X\n- X\n- X");
      await keys("u");
      assert.equal((await snapshot()).text, "- item");
      await setup("- item");
      await keys("3OX<Esc>");
      assert.equal((await snapshot()).text, "- X\n- X\n- X\n- item");
      await keys("u");
      assert.equal((await snapshot()).text, "- item");
    });
    await check("native-table-cell-identity-and-japanese", async () => {
      await setup(
        "before\n\n| A | B |\n| --- | --- |\n| 東京都に行きます | second |\n\nafter",
        false,
      );
      await page.locator(".cm-table-widget tbody tr").first().locator("td").first().dblclick();
      await page.waitForFunction(
        () => __builtin115.leaf.view.editMode.tableCell?.cm?.cm?.state.vim,
      );
      const identity = await page.evaluate(() => {
        const mode = __builtin115.leaf.view.editMode,
          parent = mode.cm,
          cell = mode.tableCell.cm,
          runtime = app.plugins.plugins.lindvimera.runtime.backend;
        cell.cm.setCursor({ line: 0, ch: 0 });
        cell.focus();
        return {
          native: cell.cm.cm6 === cell,
          separate: cell.cm.state.vim !== parent.cm.state.vim,
          extension: runtime.editorSession(cell)?.cm === cell.cm,
        };
      });
      assert.deepEqual(identity, { native: true, separate: true, extension: true });
      await keys("<Esc>w");
      const result = await page.evaluate(() => {
        const cm = __builtin115.leaf.view.editMode.tableCell.cm.cm;
        return { text: cm.getValue(), cursor: cm.getCursor() };
      });
      const expected = await page.evaluate(
        (text) => app.plugins.plugins.lindvimera.wordSegmenter().segment(text)[0].to,
        result.text,
      );
      assert.equal(result.cursor.ch, expected);
    });
    await check("native-table-dot-and-recreation", async () => {
      await setup(
        "before\n\n| A | B |\n| --- | --- |\n| one two three | four five six |\n\nafter",
        false,
      );
      await page.locator(".cm-table-widget tbody tr").first().locator("td").first().dblclick();
      await page.waitForFunction(
        () => __builtin115.leaf.view.editMode.tableCell?.cm?.cm?.state.vim,
      );
      await keys("<Esc>");
      await page.evaluate(() => {
        const cm = __builtin115.leaf.view.editMode.tableCell.cm.cm;
        cm.setCursor({ line: 0, ch: 0 });
        cm.cm6.focus();
      });
      await keys("dw.");
      assert.equal(
        await page.evaluate(() =>
          __builtin115.leaf.view.editMode.tableCell.cm.state.doc.toString(),
        ),
        "three",
      );
      await page.locator(".cm-table-widget tbody tr").first().locator("td").nth(1).dblclick();
      await keys("<Esc>");
      await page.evaluate(() => {
        const cm = __builtin115.leaf.view.editMode.tableCell.cm.cm;
        cm.setCursor({ line: 0, ch: 0 });
        cm.cm6.focus();
      });
      await keys(".");
      assert.equal(
        await page.evaluate(() =>
          __builtin115.leaf.view.editMode.tableCell.cm.state.doc.toString(),
        ),
        "five six",
      );
    });
    await check("native-parent-cell-dot-continuity", async () => {
      await setup(
        "one two\n\n| A | B |\n| --- | --- |\n| three four | five six |\n\nseven eight",
        false,
      );
      await keys("dw");
      await page.locator(".cm-table-widget tbody tr").first().locator("td").first().dblclick();
      await keys("<Esc>");
      await page.evaluate(() => {
        const cm = __builtin115.leaf.view.editMode.tableCell.cm.cm;
        cm.setCursor({ line: 0, ch: 0 });
        cm.cm6.focus();
      });
      await keys(".");
      assert.equal(
        await page.evaluate(() =>
          __builtin115.leaf.view.editMode.tableCell.cm.state.doc.toString(),
        ),
        "four",
      );
      await page.evaluate(() => {
        const mode = __builtin115.leaf.view.editMode;
        mode.destroyTableCell();
        mode.cm.cm.setCursor({ line: 6, ch: 0 });
        mode.cm.focus();
      });
      await keys(".");
      assert.ok((await snapshot()).text.endsWith("eight"));
      assert.ok(!(await snapshot()).text.endsWith("seven eight"));
    });
    await check("native-table-tab-count-and-leave", async () => {
      await setup(
        "before\n\n| A | B | C |\n| --- | --- | --- |\n| one | two | three |\n\nafter",
        false,
      );
      await page.locator(".cm-table-widget tbody tr").first().locator("td").first().dblclick();
      await keys("<Esc>");
      await keys("2<Tab>");
      await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
      assert.equal(
        await page.evaluate(() => __builtin115.leaf.view.editMode.tableCell.cell.col),
        2,
      );
      await keys("[t");
      await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
      assert.equal(await page.evaluate(() => __builtin115.leaf.view.editMode.tableCell), null);
      assert.equal((await snapshot()).cursor.line, 1);
      await page.locator(".cm-table-widget tbody tr").first().locator("td").first().dblclick();
      await keys("<Esc>]t");
      await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
      assert.equal(await page.evaluate(() => __builtin115.leaf.view.editMode.tableCell), null);
      assert.equal((await snapshot()).cursor.line, 5);
    });
    await check("native-fold-followed-by-motion", async () => {
      await setup("# Head\ninside\n\n# Next\nend", false);
      await keys("zcj");
      assert.equal((await snapshot()).cursor.line, 3);
      await keys("zR");
    });
    await check("native-marks-across-recreated-cell", async () => {
      await setup(
        "body alpha\n\n| A | B |\n| --- | --- |\n| one two three | four five six |\n\nafter",
        false,
      );
      await keys("ma");
      await page.locator(".cm-table-widget tbody tr").first().locator("td").first().dblclick();
      await keys("<Esc>");
      await page.evaluate(() => {
        const cm = __builtin115.leaf.view.editMode.tableCell.cm.cm;
        cm.setCursor({ line: 0, ch: 4 });
        cm.cm6.focus();
      });
      await keys("mb");
      await page.evaluate(() => {
        const mode = __builtin115.leaf.view.editMode;
        mode.destroyTableCell();
        mode.cm.cm.setCursor({ line: 6, ch: 0 });
        mode.cm.focus();
      });
      await keys("`b");
      await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
      assert.equal(
        await page.evaluate(() => __builtin115.leaf.view.editMode.tableCell?.cm.cm.getCursor().ch),
        4,
      );
      await keys("`a");
      await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
      assert.equal((await snapshot()).cursor.line, 0);
    });
    await check("native-jumplist-back-forward", async () => {
      await setup("first\nsecond\nthird\nlast");
      await keys("G");
      const g = await snapshot();
      await keys("<C-o>");
      await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
      const keyboardO = await snapshot();
      if (keyboardO.cursor.line !== 0) {
        const focus = await page.evaluate(() => ({
          active: document.activeElement?.outerHTML.slice(0, 500),
          modal: [...document.querySelectorAll(".modal-container")].map((element) =>
            element.textContent.slice(0, 200),
          ),
        }));
        await page.evaluate(() =>
          CodeMirrorAdapter.Vim.handleKey(__builtin115.leaf.view.editMode.cm.cm, "<C-o>"),
        );
        await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
        checks.jumpStages = { g, keyboardO, focus, directO: await snapshot() };
      }
      assert.equal(keyboardO.cursor.line, 0);
      await keys("<C-i>");
      await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
      assert.equal((await snapshot()).cursor.line, 3);
    });
    await check("native-macro-after-cell-restore", async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await setup(
          "body\n\n| A | B |\n| --- | --- |\n| one two three | four five six |\n\nafter",
          false,
        );
        await page.locator(".cm-table-widget tbody tr").first().locator("td").first().dblclick();
        await keys("<Esc>");
        await page.evaluate(() => {
          const cm = __builtin115.leaf.view.editMode.tableCell.cm.cm;
          cm.setCursor({ line: 0, ch: 0 });
          cm.cm6.focus();
        });
        await keys("mb");
        await page.evaluate(() => {
          const mode = __builtin115.leaf.view.editMode;
          mode.destroyTableCell();
          mode.cm.cm.setCursor({ line: 0, ch: 0 });
          mode.cm.focus();
        });
        const beforeRecord = (await snapshot()).text;
        await keys("qa`blq");
        await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
        assert.equal((await snapshot()).text, beforeRecord);
        assert.equal(
          await page.evaluate(
            () => CodeMirrorAdapter.Vim.getVimGlobalState_().macroModeState.isRecording,
          ),
          false,
        );
        await page.evaluate(() => {
          const mode = __builtin115.leaf.view.editMode;
          mode.destroyTableCell();
          mode.cm.cm.setCursor({ line: 0, ch: 0 });
          mode.cm.focus();
        });
        await keys("@a");
        await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.settled());
        assert.equal(
          await page.evaluate(
            () => __builtin115.leaf.view.editMode.tableCell?.cm.cm.getCursor().ch,
          ),
          1,
        );
      }
    });
    await check("conflict-suspension", async () => {
      await setup("alpha beta");
      await page.evaluate(() => app.vault.setConfig("vimMode", false));
      await page.waitForFunction(
        () => app.plugins.plugins.lindvimera.runtime.engine.status === "suspended",
      );
      assert.equal(
        await page.evaluate(() => app.plugins.plugins.lindvimera.runtime.backend.status().active),
        false,
      );
      await page.evaluate(() => app.vault.setConfig("vimMode", true));
    });
    await check("native-confirmation-cancels-on-disable", async () => {
      await setup("a a");
      await page.evaluate(() =>
        CodeMirrorAdapter.Vim.handleEx(__builtin115.leaf.view.editMode.cm.cm, "%s/a/A/gc"),
      );
      await page.evaluate(async () => {
        const plugin = app.plugins.plugins.lindvimera;
        plugin.settings.enabled = false;
        await plugin.saveSettings();
      });
      assert.equal(
        await page.evaluate(() => !!__builtin115.leaf.view.editMode.cm.cm.state.dialog),
        false,
      );
      await keys("y");
      assert.equal((await snapshot()).text, "a a");
      await page.evaluate(async () => {
        const plugin = app.plugins.plugins.lindvimera;
        plugin.settings.enabled = true;
        await plugin.saveSettings();
      });
      await keys("<Esc>");
    });
    await check("reload-native-mode-isolation", async () => {
      await page.evaluate(async () => {
        await app.plugins.disablePlugin("lindvimera");
        await app.plugins.enablePlugin("lindvimera");
      });
      await page.waitForFunction(
        () => app.plugins.plugins.lindvimera?.runtime?.engine.status === "active",
      );
      assert.equal(
        await page.evaluate(
          () => app.plugins.plugins.lindvimera.runtime.backend.Vim === CodeMirrorAdapter.Vim,
        ),
        true,
      );
    });
    const available = await page.evaluate(
      () => app.plugins.plugins.lindvimera.runtime.engine.available,
    );
    checks.availableEngines = available;
    if (available.includes("embedded") && available.includes("builtin")) {
      await check("native-embedded-selection-reload", async () => {
        await setup("alpha beta");
        await page.evaluate(() => app.plugins.plugins.lindvimera.selectEngine("embedded"));
        assert.deepEqual(
          await page.evaluate(() => ({
            requested: app.plugins.plugins.lindvimera.runtime.engine.requested,
            active: app.plugins.plugins.lindvimera.runtime.engine.active,
            flag: app.vault.getConfig("vimMode"),
          })),
          { requested: "embedded", active: "builtin", flag: true },
        );
        await page.evaluate(async () => {
          await app.plugins.disablePlugin("lindvimera");
          await app.plugins.enablePlugin("lindvimera");
        });
        await page.waitForFunction(
          () => app.plugins.plugins.lindvimera.runtime.engine.status === "active",
        );
        assert.deepEqual(
          await page.evaluate(() => ({
            active: app.plugins.plugins.lindvimera.runtime.engine.active,
            flag: app.vault.getConfig("vimMode"),
          })),
          { active: "embedded", flag: false },
        );
        await page.evaluate(() => __builtin115.leaf.view.editMode.cm.focus());
        await keys("dw");
        assert.equal(
          await page.evaluate(() => __builtin115.leaf.view.editMode.cm.state.doc.toString()),
          "beta",
        );
        await page.evaluate(() => app.plugins.plugins.lindvimera.selectEngine("builtin"));
        assert.equal(await page.evaluate(() => app.vault.getConfig("vimMode")), false);
        await page.evaluate(async () => {
          await app.plugins.disablePlugin("lindvimera");
          await app.plugins.enablePlugin("lindvimera");
        });
        await page.waitForFunction(
          () => app.plugins.plugins.lindvimera.runtime.engine.status === "active",
        );
        assert.deepEqual(
          await page.evaluate(() => ({
            active: app.plugins.plugins.lindvimera.runtime.engine.active,
            flag: app.vault.getConfig("vimMode"),
            identity: app.plugins.plugins.lindvimera.runtime.backend.Vim === CodeMirrorAdapter.Vim,
          })),
          { active: "builtin", flag: true, identity: true },
        );
      });
    }
    await delay(100);
    await check("live-preview-decorations", async () => {
      const lpDoc = [
        "0123456789",
        "ab<ins>cdefgh</ins>ij",
        "abc**def**ghi",
        "ab[[target|cdefgh]]ij",
        "- ab<ins>cdef</ins>gh",
        "foo <ins>bar</ins> baz",
        "<ins>日本語テスト</ins> 末尾",
        "0123456789abc",
        "prefix <ins>abcdef</ins> suffix",
      ].join("\n");
      await setup(lpDoc, false);
      await page.waitForFunction(
        () => document.querySelectorAll(".workspace-leaf.mod-active .cm-html-embed").length >= 3,
      );
      await delay(250);

      // j/k preserve visible body column 5 across <ins>, wikilink, list prefix -
      await keys("gg05lj");
      assert.deepEqual((await snapshot()).cursor, { line: 1, ch: 10 });
      await keys("2j");
      assert.deepEqual((await snapshot()).cursor, { line: 3, ch: 14 });
      await keys("j");
      assert.deepEqual((await snapshot()).cursor, { line: 4, ch: 12 });
      await keys("3k");
      assert.deepEqual((await snapshot()).cursor, { line: 1, ch: 10 });

      // $j and $hj reset lastHPos
      await keys("gg$j");
      assert.deepEqual((await snapshot()).cursor, { line: 1, ch: 20 });
      await keys("gg$hj");
      assert.deepEqual((await snapshot()).cursor, { line: 1, ch: 19 });

      // l entry into collapsed abc**def**ghi skips '**' and resists Obsidian _x snap!
      await keys("gg2j02l");
      await delay(100);
      await keys("l");
      assert.deepEqual((await snapshot()).cursor, { line: 2, ch: 5 });
      await keys("l");
      assert.deepEqual((await snapshot()).cursor, { line: 2, ch: 6 });
      await keys("2h");
      assert.deepEqual((await snapshot()).cursor, { line: 2, ch: 4 });

      // Collapsed <ins>bar</ins> l entry + expanded h/l char-by-char editing
      await keys("gg5j03l");
      await delay(100);
      await keys("l");
      assert.deepEqual((await snapshot()).cursor, { line: 5, ch: 9 });
      await keys("l");
      assert.deepEqual((await snapshot()).cursor, { line: 5, ch: 10 });
      await keys("2h");
      assert.deepEqual((await snapshot()).cursor, { line: 5, ch: 8 });

      // w / b / W / ^ across collapsed <ins>
      await keys("gg5j0");
      await delay(100);
      await keys("w");
      assert.deepEqual((await snapshot()).cursor, { line: 5, ch: 9 });
      await keys("0");
      await delay(100);
      await keys("W");
      assert.deepEqual((await snapshot()).cursor, { line: 5, ch: 9 });
      await keys("$b");
      await delay(100);
      await keys("b");
      assert.deepEqual((await snapshot()).cursor, { line: 5, ch: 9 });

      await keys("gg6j$");
      await delay(100);
      await keys("^");
      assert.deepEqual((await snapshot()).cursor, { line: 6, ch: 5 });

      // gj from line 7 col 9 ('9') onto line 8 collapsed <ins>abcdef</ins> lands inside text
      await keys("gg7j09lgj");
      {
        const cur = (await snapshot()).cursor;
        assert.equal(cur.line, 8);
        assert.ok(cur.ch >= 12 && cur.ch <= 17, `gj into <ins>abcdef</ins> landed at ${cur.ch}`);
      }

      // Real Playwright locator click on 'd' inside line 8 <ins>abcdef</ins>
      await keys("gg0");
      await delay(150);
      const rel = await page.evaluate(() => {
        document.querySelectorAll(".notice-container .notice").forEach((n) => n.remove());
        const embeds = [
          ...document.querySelectorAll(".workspace-leaf.mod-active .cm-html-embed ins"),
        ];
        const target = embeds.find((el) => (el.textContent ?? "").includes("abcdef"));
        if (!target) throw new Error("Target <ins>abcdef</ins> embed not found");
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
        let textNode = null;
        while ((textNode = walker.nextNode())) {
          if ((textNode.nodeValue ?? "").includes("abcdef")) break;
        }
        const range = document.createRange();
        range.setStart(textNode, 3);
        range.setEnd(textNode, 4);
        const charRect = range.getClientRects()[0] ?? range.getBoundingClientRect();
        const elRect = target.getBoundingClientRect();
        return {
          x: (charRect.left + charRect.right) / 2 - elRect.left,
          y: (charRect.top + charRect.bottom) / 2 - elRect.top,
        };
      });
      await page
        .locator(".workspace-leaf.mod-active .cm-html-embed ins", { hasText: "abcdef" })
        .first()
        .click({ position: rel });
      await page.waitForFunction(
        () => __builtin115.leaf.view.editMode.cm.state.selection.main.head !== 0,
        undefined,
        { timeout: 3_000 },
      );
      assert.deepEqual((await snapshot()).cursor, { line: 8, ch: 15 });

      // dw operator and Source mode keep raw source offsets
      await keys("ggj0dw");
      assert.ok((await snapshot()).text.split("\n")[1] === "<ins>cdefgh</ins>ij");

      await setup(lpDoc, true);
      await delay(100);
      await keys("gg05lj");
      assert.deepEqual((await snapshot()).cursor, { line: 1, ch: 5 });
    });
    await check("renderer-errors", () => assert.deepEqual(rendererErrors, []));
    environment.afterHashes = await verifyRuntimeFiles(
      environment.candidateHashes,
      environment.plugin,
    );
    await verifyRuntimeFiles(environment.candidateHashes, join(root, "dist"));
  } finally {
    await writeFile(
      results,
      JSON.stringify({ run, environment, checks, rendererErrors, log }, null, 2),
    );
    if (browser) {
      await Promise.race([
        browser
          .newBrowserCDPSession()
          .then((session) => session.send("Browser.close"))
          .catch(() => {}),
        delay(3000),
      ]);
      await Promise.race([browser.close().catch(() => {}), delay(3000)]);
    }
    if (child?.exitCode === null) {
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3000)]);
      if (child.exitCode === null) child.kill();
    }
  }
  const failed = Object.entries(checks).filter(([, value]) => value.passed === false);
  assert.equal(failed.length, 0, failed.map(([name]) => name).join(", "));
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runBuiltinProbe();
