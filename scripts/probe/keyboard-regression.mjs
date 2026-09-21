import assert from "node:assert/strict";

export const keyboardChecks = [
  "clean-install-default-settings",
  "clean-install-body-escape",
  "host-keyboard-special-keys",
  "host-keyboard-mode-hotkeys",
  "host-keyboard-suggestion-cancel",
  "host-keyboard-search-isolation",
  "host-keyboard-modal-isolation",
  "host-keyboard-shortcut-cancels-pending",
  "host-keyboard-invalid-command",
  "host-keyboard-replace-status",
  "host-keyboard-screen-motions",
  "host-keyboard-composition-delegation",
  "physical-body-escape",
];

/** Real MarkdownViews, standard core plugins, production defaults and trusted key events.
 * Only fixture setup and state inspection use evaluate; measured actions use CDP or OS keys.
 */
export async function runKeyboardRegression(page, sendPhysicalEscape) {
  const checks = {};
  let serial = 0;
  const check = async (name, callback) => {
    console.log(`Obsidian keyboard: ${name}`);
    try {
      await callback();
      checks[name] = { passed: true, detail: "All assertions passed." };
    } catch (error) {
      const observed = await snapshot().catch(() => undefined);
      checks[name] = {
        passed: false,
        detail: `${error.stack ?? String(error)}\nObserved: ${JSON.stringify(observed)}`,
      };
      console.error(`${name}: ${error.message}`);
    }
    checks[name].observedAt = new Date().toISOString();
  };
  const snapshot = () =>
    page.evaluate(() => {
      const view = globalThis.__lindvimeraKeyboardProbe.leaf.view.editMode.cm;
      const cm = view.cm;
      const state = cm.state.vim;
      return {
        text: view.state.doc.toString(),
        cursor: cm.getCursor(),
        insert: !!state.insertMode,
        visual: !!state.visualMode,
        operator: state.inputState.operator ?? null,
        keyBuffer: state.inputState.keyBuffer,
        status: [...document.querySelectorAll(".status-bar-item")]
          .map((item) => item.textContent)
          .find((text) => text.startsWith("Lindvimera")),
        scrollTop: view.scrollDOM.scrollTop,
        focus: document.activeElement?.className,
      };
    });
  const setup = async (source = true, text = "alpha beta\n  second line\nthird line\n") => {
    await page.keyboard.press("Escape");
    await page.evaluate(() => globalThis.app.setting.close());
    const path = `Keyboard regression ${++serial}.md`;
    await page.evaluate(
      async ({ path, source, text }) => {
        const app = globalThis.app;
        const old = globalThis.__lindvimeraKeyboardProbe;
        old?.remove?.();
        const leaf = old?.leaf ?? app.workspace.getLeaf("tab");
        const file = await app.vault.create(path, text);
        await leaf.openFile(file, { state: { mode: "source", source } });
        app.workspace.setActiveLeaf(leaf, { focus: true });
        globalThis.__lindvimeraKeyboardProbe = { leaf, events: [], calls: 0 };
      },
      { path, source, text },
    );
    await page.waitForFunction(
      ({ path, source }) => {
        const view = globalThis.__lindvimeraKeyboardProbe.leaf.view;
        return (
          view.file?.path === path &&
          view.editMode?.sourceMode === source &&
          view.editMode.cm.cm?.state.vim
        );
      },
      { path, source },
    );
    await page.evaluate(() => {
      const probe = globalThis.__lindvimeraKeyboardProbe;
      const editor = probe.leaf.view.editMode.cm;
      probe.leaf.view.editor.setCursor({ line: 0, ch: 0 });
      const observed = new WeakSet();
      const record = (event) => {
        if (editor.contentDOM.contains(event.target) && !observed.has(event)) {
          observed.add(event);
          probe.events.push({
            key: event.key,
            trusted: event.isTrusted,
            composing: event.isComposing,
          });
        }
      };
      // A handled Vim key stops in Obsidian's window-capture scope before it
      // reaches document listeners. Observe the scope entry without changing
      // its return value, dispatch count, event flags or ordering.
      const scope = probe.leaf.view.scope;
      const handle = scope.handleKey;
      const observedHandle = function (event, context) {
        record(event);
        return handle.call(this, event, context);
      };
      scope.handleKey = observedHandle;
      document.addEventListener("keydown", record, true);
      probe.remove = () => {
        document.removeEventListener("keydown", record, true);
        if (scope.handleKey === observedHandle) scope.handleKey = handle;
      };
      editor.focus();
    });
    await page.keyboard.press("Escape");
    assert.equal((await snapshot()).insert, false, "Fixture did not enter Normal mode.");
  };
  const insertEscape = async (send) => {
    await send();
    const state = await snapshot();
    assert.equal(
      state.text,
      "abcjj",
      "Default typing/Escape lost or duplicated inserted characters.",
    );
    assert.equal(state.insert, false, "Default Escape did not return to Normal mode.");
    assert.match(state.status, /NORMAL/, "Displayed mode disagrees with the editor.");
    await page.keyboard.press("u");
    assert.equal((await snapshot()).text, "", "One Undo did not remove the whole insertion.");
    await page.keyboard.press("Control+r");
    assert.equal((await snapshot()).text, "abcjj", "Redo did not restore the insertion.");
    // Paste the last-insert register through the ordinary key route. It must contain
    // the literal jj and must not contain the Escape key or duplicate input.
    await page.keyboard.type('$".p');
    assert.equal((await snapshot()).text, "abcjjabcjj", "The last-insert register is not abcjj.");
    await page.keyboard.press("u");
    assert.equal((await snapshot()).text, "abcjj", "Register paste did not form one Undo step.");
  };
  const suggestionVisible = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".suggestion-container")].some(
        (element) => element.getBoundingClientRect().height > 0,
      ),
    );
  try {
    await check("clean-install-default-settings", async () => {
      const settings = await page.evaluate(async () => {
        const app = globalThis.app;
        return {
          saved: await app.vault.adapter.exists(".obsidian/plugins/lindvimera/data.json"),
          escape: app.plugins.plugins.lindvimera.settings.escapeSequences,
          probe: app.plugins.plugins.lindvimera.settings.probeEnabled,
          builtin: app.isVimEnabled(),
          palette: !!app.commands.commands["command-palette:open"],
          search: !!app.commands.commands["global-search:open"],
        };
      });
      assert.deepEqual(settings, {
        saved: false,
        escape: [],
        probe: false,
        builtin: false,
        palette: true,
        search: true,
      });
    });
    await check("clean-install-body-escape", async () => {
      for (const source of [true, false]) {
        await setup(source, "");
        await insertEscape(async () => {
          await page.keyboard.type("iabcjj");
          await page.keyboard.press("Escape");
        });
      }
    });
    await check("host-keyboard-special-keys", async () => {
      for (const source of [true, false]) {
        await setup(source);
        await page.keyboard.press("ArrowRight");
        assert.deepEqual((await snapshot()).cursor, { line: 0, ch: 1 });
        await page.keyboard.press("ArrowLeft");
        assert.deepEqual((await snapshot()).cursor, { line: 0, ch: 0 });
        await page.keyboard.press("ArrowDown");
        assert.equal((await snapshot()).cursor.line, 1);
        await page.keyboard.press("ArrowUp");
        assert.equal((await snapshot()).cursor.line, 0);
        await page.keyboard.press("End");
        assert.equal(
          (await snapshot()).cursor.ch,
          9,
          "Normal End must stop on the last character.",
        );
        await page.keyboard.press("Home");
        assert.equal((await snapshot()).cursor.ch, 0);
        await page.keyboard.type("lll");
        await page.keyboard.press("Backspace");
        assert.equal((await snapshot()).cursor.ch, 2, "Normal Backspace must move once.");
        await page.keyboard.press("Delete");
        assert.equal((await snapshot()).text, "alha beta\n  second line\nthird line\n");
        await page.keyboard.press("u");
        await page.keyboard.press("Enter");
        assert.deepEqual((await snapshot()).cursor, { line: 1, ch: 2 });
        await page.keyboard.press("i");
        await page.keyboard.press("Control+[");
        assert.equal((await snapshot()).insert, false, "Ctrl-[ did not exit Insert.");
      }
    });
    await check("host-keyboard-mode-hotkeys", async () => {
      for (const source of [true, false]) {
        await setup(source, Array.from({ length: 180 }, (_, index) => `line ${index}`).join("\n"));
        await page.keyboard.press("Control+f");
        assert.ok((await snapshot()).cursor.line > 0, "Normal Ctrl-f did not move a page.");
        assert.equal(await page.locator(".document-search-container:visible").count(), 0);
        await page.keyboard.press("i");
        await page.keyboard.press("Control+f");
        await page.locator(".document-search-container input:visible").first().waitFor();
        assert.equal((await snapshot()).insert, true, "Insert Ctrl-f changed Vim mode.");
        await page.keyboard.press("Escape");
        assert.equal((await snapshot()).insert, true, "Closing host search also left Insert.");
      }
    });
    await check("host-keyboard-suggestion-cancel", async () => {
      for (const source of [true, false]) {
        await setup(source, "");
        await page.keyboard.type("i[[Native");
        await page.locator(".suggestion-container:visible").first().waitFor();
        assert.equal((await snapshot()).insert, true);
        const before = (await snapshot()).text;
        await page.keyboard.press("Escape");
        assert.equal(await suggestionVisible(), false, "Escape did not close link suggestions.");
        assert.equal((await snapshot()).insert, true, "Suggestion Escape also exited Insert.");
        assert.equal((await snapshot()).text, before, "Closing suggestions edited the note.");
        await page.keyboard.press("Escape");
        assert.equal((await snapshot()).insert, false, "Second Escape did not return to Normal.");
      }
    });
    await check("host-keyboard-search-isolation", async () => {
      await setup();
      await page.keyboard.type("i");
      await page.keyboard.press("Control+f");
      const search = page.locator(".document-search-container input:visible").first();
      await search.waitFor();
      await search.fill("");
      const before = (await snapshot()).text;
      await page.keyboard.type("dwijj");
      assert.equal(await search.inputValue(), "dwijj");
      assert.equal((await snapshot()).text, before);
      await page.keyboard.press("Escape");
      assert.equal((await snapshot()).insert, true);
    });
    await check("host-keyboard-modal-isolation", async () => {
      await setup();
      await page.keyboard.press("i");
      assert.equal(
        await page.evaluate(() =>
          globalThis.app.commands.executeCommandById("command-palette:open"),
        ),
        true,
      );
      const input = page.locator(".prompt-input:visible");
      await input.waitFor();
      await page.keyboard.type("dwijj");
      assert.equal(await input.inputValue(), "dwijj");
      await page.keyboard.press("Escape");
      await input.waitFor({ state: "hidden" });
      assert.equal((await snapshot()).insert, true, "Modal Escape changed the background mode.");
    });
    await check("host-keyboard-shortcut-cancels-pending", async () => {
      await setup();
      await page.evaluate(() => {
        const probe = globalThis.__lindvimeraKeyboardProbe;
        const handler = globalThis.app.scope.register(["Ctrl", "Alt"], "y", () => {
          probe.calls++;
          return false;
        });
        const remove = probe.remove;
        probe.remove = () => {
          remove();
          handler.scope.unregister(handler);
        };
      });
      await page.keyboard.type('"a2d');
      assert.equal((await snapshot()).operator, "delete");
      await page.keyboard.press("Control+Alt+y");
      assert.equal(await page.evaluate(() => globalThis.__lindvimeraKeyboardProbe.calls), 1);
      assert.equal((await snapshot()).operator, null, "Host shortcut retained a pending deletion.");
      await page.keyboard.press("w");
      assert.equal((await snapshot()).cursor.ch, 6, "Count leaked across host delegation.");
      assert.equal((await snapshot()).text, "alpha beta\n  second line\nthird line\n");
    });
    await check("host-keyboard-invalid-command", async () => {
      await setup();
      const before = (await snapshot()).text;
      await page.keyboard.type(":Qd~");
      assert.equal(
        (await snapshot()).text,
        before,
        "Unsupported or invalid command edited the note.",
      );
      assert.equal((await snapshot()).insert, false);
      assert.equal((await snapshot()).operator, null, "Invalid command left an operator pending.");
      await page.keyboard.press("w");
      assert.equal((await snapshot()).text, before);
      assert.equal((await snapshot()).cursor.ch, 6);
    });
    await check("host-keyboard-replace-status", async () => {
      for (const source of [true, false]) {
        await setup(source);
        await page.keyboard.press("R");
        assert.match((await snapshot()).status, /REPLACE/, "Replace mode is displayed as Insert.");
        await page.keyboard.type("Z");
        await page.keyboard.press("Escape");
        assert.equal((await snapshot()).text, "Zlpha beta\n  second line\nthird line\n");
        assert.equal((await snapshot()).insert, false);
        assert.match((await snapshot()).status, /NORMAL/);
        await page.keyboard.press("u");
        assert.equal((await snapshot()).text, "alpha beta\n  second line\nthird line\n");
      }
    });
    await check("host-keyboard-screen-motions", async () => {
      for (const source of [true, false]) {
        const text = Array.from({ length: 240 }, (_, index) => `line ${index}`).join("\n");
        await setup(source, text);
        for (const [down, up] of [
          ["Control+f", "Control+b"],
          ["Control+d", "Control+u"],
          ["PageDown", "PageUp"],
        ]) {
          await page.keyboard.type("gg");
          await page.keyboard.press(down);
          const lower = (await snapshot()).cursor.line;
          assert.ok(lower > 0, `${down} did not move down.`);
          await page.keyboard.press(up);
          assert.ok((await snapshot()).cursor.line < lower, `${up} did not move up.`);
        }
        await page.keyboard.type("100Gzz");
        await page.waitForTimeout(80);
        const center = await snapshot();
        await page.keyboard.type("zt");
        await page.waitForTimeout(80);
        const top = await snapshot();
        await page.keyboard.type("zb");
        await page.waitForTimeout(80);
        const bottom = await snapshot();
        assert.ok(
          top.scrollTop > center.scrollTop && center.scrollTop > bottom.scrollTop,
          `zt/zz/zb scroll order differs: ${top.scrollTop}/${center.scrollTop}/${bottom.scrollTop}`,
        );
        assert.deepEqual(top.cursor, center.cursor);
        assert.deepEqual(bottom.cursor, center.cursor);
        await page.keyboard.type("zzH");
        const high = (await snapshot()).cursor.line;
        await page.keyboard.press("M");
        const middle = (await snapshot()).cursor.line;
        await page.keyboard.press("L");
        const low = (await snapshot()).cursor.line;
        assert.ok(high < middle && middle < low, `H/M/L order differs: ${high}/${middle}/${low}`);
        assert.equal((await snapshot()).text, text);
        await setup(source, `${"wrapped words ".repeat(140)}\nnext line`);
        await page.keyboard.type("gj");
        const lowerVisualLine = (await snapshot()).cursor;
        assert.equal(lowerVisualLine.line, 0, "gj moved to another logical line.");
        assert.ok(lowerVisualLine.ch > 0, "gj did not move down a wrapped display line.");
        await page.keyboard.type("gk");
        assert.deepEqual((await snapshot()).cursor, { line: 0, ch: 0 });
        await page.keyboard.press("g");
        await page.keyboard.press("ArrowDown");
        assert.deepEqual((await snapshot()).cursor, lowerVisualLine, "g<Down> differs from gj.");
        await page.keyboard.press("g");
        await page.keyboard.press("ArrowUp");
        assert.deepEqual((await snapshot()).cursor, { line: 0, ch: 0 }, "g<Up> differs from gk.");
      }
    });
    await check("host-keyboard-composition-delegation", async () => {
      await setup();
      await page.keyboard.press("i");
      const prevented = await page.evaluate(() => {
        const input = globalThis.__lindvimeraKeyboardProbe.leaf.view.editMode.cm.contentDOM;
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        const event = new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(event);
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
        return event.defaultPrevented;
      });
      assert.equal((await snapshot()).insert, true, "Composition Escape changed Vim mode.");
      assert.equal(prevented, false, "Composition Escape was consumed.");
      // Real IME conversion is deliberately not claimed by this synthetic boundary check.
    });
    await check("physical-body-escape", async () => {
      await setup(false, "");
      await page.evaluate(() => {
        globalThis.__lindvimeraKeyboardProbe.events = [];
      });
      await insertEscape(async () => {
        await sendPhysicalEscape();
        await page.waitForFunction(() => globalThis.__lindvimeraKeyboardProbe.events.length === 7);
        const events = await page.evaluate(() => globalThis.__lindvimeraKeyboardProbe.events);
        assert.deepEqual(
          events.map((event) => event.key),
          ["i", "a", "b", "c", "j", "j", "Escape"],
        );
        assert.ok(events.every((event) => event.trusted && !event.composing));
      });
    });
  } finally {
    await page.evaluate(() => {
      const probe = globalThis.__lindvimeraKeyboardProbe;
      probe?.remove?.();
      probe?.leaf.detach();
      delete globalThis.__lindvimeraKeyboardProbe;
    });
  }
  return checks;
}
