import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

/** Inspect rendered cursors in real MarkdownViews in the disposable test Vault. */
export async function checkCursorColors(page) {
  const saved = await page.evaluate(() => ({
    settings: structuredClone(app.plugins.plugins.lindvimera.settings),
    light: document.body.classList.contains("theme-light"),
    dark: document.body.classList.contains("theme-dark"),
  }));
  const observations = [];
  const text = "alpha beta\n\n| Name | Value |\n| --- | --- |\n| alpha | beta |\n\nlast line\n";
  const color = "rgb(18, 171, 205)";
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  // CodeMirror applies its focus class in a timer after the DOM focus event.
  // Animation frames alone can run before that update on a fast display.
  const waitForFocus = (focused) =>
    page.waitForFunction((focused) => {
      const probe = globalThis.__lindvimeraColorProbe;
      const owner = probe.leaf.view.editMode;
      const view = probe.native ? owner.tableCell?.cm : owner.cm;
      return view?.hasFocus === focused && view.dom.classList.contains("cm-focused") === focused;
    }, focused);
  async function read() {
    return page.evaluate(() => {
      const probe = globalThis.__lindvimeraColorProbe;
      const owner = probe.leaf.view.editMode;
      const view = probe.native ? owner.tableCell?.cm : owner.cm;
      if (!view) throw new Error("Cursor fixture lost its editor.");
      const block = view.dom.querySelector(
        ":scope > .cm-scroller > .cm-vimCursorLayer .cm-fat-cursor",
      );
      const line = view.dom.querySelector(
        ":scope > .cm-scroller > .cm-cursorLayer:not(.cm-vimCursorLayer) .cm-cursor",
      );
      const style = block && getComputedStyle(block);
      const rect = block?.getBoundingClientRect();
      const lineRect = line?.getBoundingClientRect();
      return {
        block: style?.backgroundColor,
        outline: style?.outlineColor,
        outlineStyle: style?.outlineStyle,
        blockWidth: rect?.width,
        blockHeight: rect?.height,
        layerDisplay: block && getComputedStyle(block.parentElement).display,
        caret: getComputedStyle(view.contentDOM).caretColor,
        drawnCaret: line && getComputedStyle(line).borderLeftColor,
        drawnCaretHeight: lineRect?.height,
        drawnCaretWidth: lineRect?.width,
        drawnLayerDisplay: line && getComputedStyle(line.parentElement).display,
        mode: owner.cm.dom.dataset.lindvimeraMode,
        custom: owner.cm.dom.classList.contains("lindvimera-custom-cursor"),
        variable: owner.cm.dom.style.getPropertyValue("--lindvimera-cursor-color"),
        text: owner.cm.state.doc.toString(),
        focused: view.hasFocus,
        focusClass: view.dom.classList.contains("cm-focused"),
      };
    });
  }
  async function save(value) {
    await page.evaluate(async (value) => {
      const plugin = app.plugins.plugins.lindvimera;
      plugin.settings.cursorColor = value;
      await plugin.saveSettings(true);
    }, value);
    await settle();
  }
  async function focus() {
    await page.evaluate(() => {
      const probe = globalThis.__lindvimeraColorProbe;
      const owner = probe.leaf.view.editMode;
      (probe.native ? owner.tableCell.cm : owner.cm).focus();
    });
    await waitForFocus(true);
    await settle();
  }
  try {
    await page.evaluate(async (text) => {
      app.setting.close();
      const leaf = app.workspace.getLeaf("tab");
      const file = await app.vault.create("Cursor colors regression.md", text);
      globalThis.__lindvimeraColorProbe = { leaf, file, native: false };
    }, text);
    for (const source of [true, false]) {
      await page.evaluate(async (source) => {
        const probe = globalThis.__lindvimeraColorProbe;
        probe.native = false;
        await probe.leaf.openFile(probe.file, { state: { mode: "source", source } });
        app.workspace.setActiveLeaf(probe.leaf, { focus: true });
        probe.leaf.view.editor.setCursor({ line: 0, ch: 0 });
      }, source);
      await page.waitForFunction((source) => {
        const view = globalThis.__lindvimeraColorProbe.leaf.view;
        return view.editMode.sourceMode === source && view.editMode.cm.cm?.state.vim;
      }, source);
      for (const surface of source ? ["source"] : ["live-preview", "native-cell"]) {
        if (surface === "native-cell") {
          await page
            .locator(".workspace-leaf.mod-active .cm-table-widget td")
            .filter({ hasText: "alpha" })
            .dblclick();
          await page.waitForFunction(
            () => !!globalThis.__lindvimeraColorProbe.leaf.view.editMode.tableCell?.cm,
          );
          await page.evaluate(() => {
            globalThis.__lindvimeraColorProbe.native = true;
          });
        }
        for (const theme of ["light", "dark"]) {
          await page.evaluate((theme) => {
            document.body.classList.toggle("theme-light", theme === "light");
            document.body.classList.toggle("theme-dark", theme === "dark");
          }, theme);
          await focus();
          await page.keyboard.press("Escape");
          await save(null);
          const baseline = await read();
          assert.equal(baseline.custom, false);
          await save("#12abcd");
          for (const [mode, key] of [
            ["NORMAL", null],
            ["VISUAL", "v"],
            ["REPLACE", "Shift+R"],
            ["INSERT", "i"],
          ]) {
            await page.keyboard.press("Escape");
            if (key) await page.keyboard.press(key);
            await settle();
            const state = await read();
            assert.equal(state.mode, mode, `${surface}/${theme}: entered ${mode}.`);
            assert.equal(
              state.custom,
              true,
              `${surface}/${theme}: custom styling survives mode changes.`,
            );
            if (mode === "INSERT") {
              // Native cells use drawSelection: the DOM caret is intentionally
              // transparent and a separate CodeMirror cursor layer is visible.
              if (state.caret === "rgba(0, 0, 0, 0)") {
                assert.equal(
                  state.drawnCaret,
                  color,
                  `${surface}/${theme}: drawn insertion caret color.`,
                );
                assert.ok(state.drawnCaretWidth > 0 && state.drawnCaretHeight > 0);
                assert.notEqual(state.drawnLayerDisplay, "none");
              } else {
                assert.equal(
                  state.caret,
                  color,
                  `${surface}/${theme}: native insertion caret color.`,
                );
              }
            } else {
              assert.equal(state.block, color, `${surface}/${theme}/${mode}: block color.`);
              assert.ok(
                state.blockWidth > 0 && state.blockHeight > 0,
                `${surface}/${theme}/${mode}: block has rendered dimensions.`,
              );
              assert.notEqual(
                state.layerDisplay,
                "none",
                `${surface}/${theme}/${mode}: cursor layer is displayed.`,
              );
            }
            // Obsidian normalizes Markdown table padding when a cell is opened.
            // Compare against the settled surface before changing cursor settings.
            assert.equal(
              state.text,
              baseline.text,
              "Color and mode changes do not edit the document.",
            );
            if (mode === "NORMAL" || mode === "INSERT")
              await page.screenshot({
                path: fileURLToPath(
                  new URL(
                    `../../.test-runtime/results/cursor-${surface}-${theme}-${mode.toLowerCase()}.png`,
                    import.meta.url,
                  ),
                ),
              });
            observations.push({ surface, theme, ...state });
          }
          await page.keyboard.press("Escape");
          // A separate input keeps the editor mounted while giving it real DOM blur.
          await page.evaluate(() => {
            const input = document.createElement("input");
            input.id = "lindvimera-color-blur-probe";
            document.body.append(input);
            input.focus();
          });
          await waitForFocus(false);
          await settle();
          const blurred = await read();
          assert.equal(blurred.focused, false);
          assert.equal(
            blurred.block,
            "rgba(0, 0, 0, 0)",
            JSON.stringify({ surface, theme, blurred }),
          );
          assert.equal(blurred.outline, color);
          assert.equal(blurred.outlineStyle, "solid");
          await page.evaluate(() =>
            document.getElementById("lindvimera-color-blur-probe").remove(),
          );
          await focus();
          await save(null);
          const reset = await read();
          assert.equal(reset.custom, false);
          assert.equal(reset.variable, "");
          assert.equal(
            reset.block,
            baseline.block,
            `${surface}/${theme}: reset restores original block color.`,
          );
        }
      }
    }
    return observations;
  } finally {
    await page.evaluate(async (saved) => {
      document.getElementById("lindvimera-color-blur-probe")?.remove();
      document.body.classList.toggle("theme-light", saved.light);
      document.body.classList.toggle("theme-dark", saved.dark);
      const probe = globalThis.__lindvimeraColorProbe;
      probe?.leaf.detach();
      delete globalThis.__lindvimeraColorProbe;
      const plugin = app.plugins.plugins.lindvimera;
      plugin.settings = saved.settings;
      await plugin.saveSettings(true);
    }, saved);
  }
}
