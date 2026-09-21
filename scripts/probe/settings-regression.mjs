import assert from "node:assert/strict";

/** Exercise the actual Obsidian 1.13 settings renderer in the disposable Vault. */
export async function runSettingsRegression(page) {
  const saved = await page.evaluate(() => structuredClone(app.plugins.plugins.lindvimera.settings));
  const checks = {};
  let settingsPage;
  async function check(name, run) {
    await run();
    checks[name] = {
      passed: true,
      detail: "Passed in Obsidian settings.",
      observedAt: new Date().toISOString(),
    };
  }
  async function open() {
    await page.evaluate(() => {
      app.setting.open();
      app.setting.openTabById("lindvimera");
    });
    await page.waitForFunction(() => app.setting.modalEl.isConnected);
    // Obsidian may render Settings in a separate native window.
    for (let attempt = 0; attempt < 100; attempt++) {
      for (const candidate of page.context().pages()) {
        if (await candidate.locator(".modal.mod-settings").isVisible()) {
          settingsPage = candidate;
          return;
        }
      }
      await page.waitForTimeout(100);
    }
    throw new Error("The Obsidian settings window did not become available.");
  }
  const row = (name) =>
    settingsPage
      .locator(".modal.mod-settings .setting-item:visible")
      .filter({ has: settingsPage.locator(".setting-item-name", { hasText: name }) });
  const state = () => page.evaluate(() => structuredClone(app.plugins.plugins.lindvimera.settings));
  async function persisted(key, expected) {
    await page.waitForFunction(
      async ({ key, expected }) => {
        const plugin = app.plugins.plugins.lindvimera;
        return (
          JSON.stringify(plugin.settings[key]) === JSON.stringify(expected) &&
          JSON.stringify((await plugin.loadData())[key]) === JSON.stringify(expected)
        );
      },
      { key, expected },
    );
  }
  try {
    await open();
    await check("settings-search", async () => {
      const search = settingsPage
        .locator(".modal.mod-settings")
        .getByPlaceholder(/search|検索/i)
        .first();
      await search.fill("日本語の分割モード");
      const result = settingsPage
        .locator(".setting-search-results")
        .getByText("日本語の分割モード", { exact: true });
      await result.waitFor({ state: "visible" });
      await result.click();
      await row("日本語の分割モード").waitFor({ state: "visible" });
      await search.fill("__lindvimera_nonexistent_setting__");
      await result.waitFor({ state: "hidden" });
      await search.fill("");
      await open();
    });
    await check("settings-validation", async () => {
      const escape = row("挿入モードの脱出キー");
      await escape.locator("textarea").fill('["jk"]');
      await persisted("escapeSequences", ["jk"]);
      await escape.locator("textarea").fill('["jj", "jjj"]');
      await escape.getByText(/complete prefixes/).waitFor();
      assert.deepEqual((await state()).escapeSequences, ["jk"]);
      await escape.locator("textarea").fill('["jk"]');
      const timeout = row("脱出キーの判定時間");
      await timeout.locator("input").fill("350");
      await persisted("escapeTimeoutMs", 350);
      await timeout.locator("input").fill("-1");
      await timeout.getByText(/positive number/).waitFor();
      assert.equal((await state()).escapeTimeoutMs, 350);
      await timeout.locator("input").fill("350");
      const mappings = row("モード別キー割り当て");
      const valid = [{ mode: "normal", from: "H", to: "0" }];
      await mappings.locator("textarea").fill(JSON.stringify(valid));
      await persisted("keyBindings", valid);
      await mappings.locator("textarea").fill("[");
      await mappings
        .locator(".lindvimera-setting-error")
        .filter({ hasText: /JSON|Unexpected|Expected/ })
        .waitFor();
      assert.deepEqual((await state()).keyBindings, valid);
      await mappings.locator("textarea").fill(JSON.stringify(valid));
      await mappings.locator("textarea").fill('[{"mode":"normal","from":"j","to":"j"}]');
      await mappings.getByText(/循環/).waitFor();
      assert.deepEqual((await state()).keyBindings, valid);
      await mappings.locator("textarea").fill(JSON.stringify(valid));
    });
    await check("settings-japanese-switch", async () => {
      const dropdown = row("日本語の分割モード").locator('select:not([aria-hidden="true"])');
      await dropdown.selectOption("decompose");
      await persisted("linderaMode", "decompose");
      await row("日本語の単語・文操作").locator(".checkbox-container").click();
      await persisted("japanese", false);
      assert.equal(await dropdown.isDisabled(), true);
      assert.equal((await state()).linderaMode, "decompose");
      await row("日本語の単語・文操作").locator(".checkbox-container").click();
      await persisted("japanese", true);
      assert.equal(await dropdown.isDisabled(), false);
      assert.equal(await dropdown.inputValue(), "decompose");
    });
    await check("settings-legacy-probe", async () => {
      await page.evaluate(async (saved) => {
        app.setting.close();
        await app.plugins.plugins.lindvimera.saveData({ ...saved, probeEnabled: true });
        await app.plugins.unloadPlugin("lindvimera");
        await app.plugins.loadPlugin("lindvimera");
        await app.plugins.plugins.lindvimera.wordsReady;
      }, saved);
      assert.equal(Object.hasOwn(await state(), "probeEnabled"), false);
      assert.deepEqual(await state(), saved);
    });
    return checks;
  } finally {
    await page.evaluate(async (saved) => {
      app.setting.close();
      const plugin = app.plugins.plugins.lindvimera;
      plugin.settings = saved;
      await plugin.saveSettings();
    }, saved);
  }
}
