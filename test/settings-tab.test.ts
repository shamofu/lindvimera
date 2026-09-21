import { describe, expect, it, vi } from "vitest";
import type { App, Setting, SettingDefinition, SettingGroup } from "obsidian";
import { LindvimeraSettingTab } from "../src/settings-tab";
import { loadSettings, type LindvimeraSettings } from "../src/settings";

vi.mock("obsidian", () => ({
  PluginSettingTab: class {
    refreshDomState = vi.fn();
  },
}));

function setup(initial: Partial<LindvimeraSettings> = {}) {
  const host = {
    settings: loadSettings(initial),
    builtinVim: vi.fn(() => false),
    saveSettings: vi.fn<(wordsOnly?: boolean) => Promise<void>>().mockResolvedValue(undefined),
  };
  const tab = new LindvimeraSettingTab(
    {} as App,
    host as unknown as ConstructorParameters<typeof LindvimeraSettingTab>[1],
  );
  return { host, tab };
}

function rows(tab: LindvimeraSettingTab): SettingDefinition[] {
  return tab
    .getSettingDefinitions()
    .filter((definition): definition is SettingDefinition => !("type" in definition));
}

function control(tab: LindvimeraSettingTab, key: string) {
  const found = rows(tab).find((definition) => definition.control?.key === key)?.control;
  if (!found) throw new Error(`Missing settings control: ${key}`);
  return found;
}

describe("searchable settings", () => {
  it("exposes named, searchable controls and the custom mapping row without modifying settings", () => {
    const { host, tab } = setup();
    const before = structuredClone(host.settings);
    const definitions = rows(tab);
    expect(definitions.map((definition) => definition.control?.key).filter(Boolean)).toEqual([
      "enabled",
      "japanese",
      "linderaMode",
      "markdownMotions",
      "textObjects",
      "surround",
      "tables",
      "showStatus",
      "escapeSequences",
      "escapeTimeoutMs",
    ]);
    for (const definition of definitions) {
      expect(definition.name.trim()).not.toBe("");
      expect(definition.searchable).not.toBe(false);
    }
    expect(definitions.find((definition) => definition.render)?.name).toBe("モード別キー割り当て");
    expect(host.settings).toEqual(before);
    expect(host.saveSettings).not.toHaveBeenCalled();
  });

  it("reevaluates the mode dropdown after toggling Japanese without losing the chosen mode", async () => {
    const { host, tab } = setup({ linderaMode: "decompose" });
    const mode = control(tab, "linderaMode");
    if (mode.type !== "dropdown" || typeof mode.disabled !== "function")
      throw new Error("The mode must be a dropdown with a live disabled predicate.");
    expect(Object.keys(mode.options)).toEqual(["normal", "decompose"]);
    expect(mode.disabled()).toBe(false);
    await tab.setControlValue("japanese", false);
    expect(mode.disabled()).toBe(true);
    expect(tab.getControlValue("linderaMode")).toBe("decompose");
    await tab.setControlValue("japanese", true);
    expect(mode.disabled()).toBe(false);
    expect(host.settings.linderaMode).toBe("decompose");
    expect(tab.refreshDomState).toHaveBeenCalledTimes(2);
  });

  it("shows the built-in Vim warning only while the host reports a conflict", () => {
    const { host, tab } = setup();
    const warning = rows(tab).find((definition) => !definition.control && !definition.render);
    if (typeof warning?.visible !== "function") throw new Error("Missing live Vim warning.");
    expect(warning.visible()).toBe(false);
    host.builtinVim.mockReturnValue(true);
    expect(warning.visible()).toBe(true);
  });
});

describe("settings persistence", () => {
  it("round-trips JSON controls as arrays and timeout input as a number", async () => {
    const { host, tab } = setup();
    const escapeSequences = ["jj", "jk"];
    const keyBindings = [{ mode: "normal", from: "Q", to: "dw" }];
    await tab.setControlValue("escapeSequences", JSON.stringify(escapeSequences));
    await tab.setControlValue("keyBindings", JSON.stringify(keyBindings));
    await tab.setControlValue("escapeTimeoutMs", "350");
    const saved: unknown = JSON.parse(JSON.stringify(host.settings));
    const reloaded = loadSettings(saved);
    expect(reloaded.escapeSequences).toEqual(escapeSequences);
    expect(reloaded.keyBindings).toEqual(keyBindings);
    expect(reloaded.escapeTimeoutMs).toBe(350);
    expect(Array.isArray(host.settings.escapeSequences)).toBe(true);
    expect(Array.isArray(host.settings.keyBindings)).toBe(true);
    expect(JSON.parse(String(tab.getControlValue("escapeSequences")))).toEqual(escapeSequences);
    expect(JSON.parse(String(tab.getControlValue("keyBindings")))).toEqual(keyBindings);
    expect(tab.getControlValue("escapeTimeoutMs")).toBe("350");
  });

  it("uses word-only saves for Japanese controls and full saves for other edits", async () => {
    const { host, tab } = setup();
    await tab.setControlValue("japanese", false);
    await tab.setControlValue("linderaMode", "decompose");
    for (const key of [
      "enabled",
      "markdownMotions",
      "textObjects",
      "surround",
      "tables",
      "showStatus",
    ])
      await tab.setControlValue(key, false);
    await tab.setControlValue("escapeSequences", '["jk"]');
    await tab.setControlValue("escapeTimeoutMs", "300");
    await tab.setControlValue("keyBindings", '[{"mode":"normal","from":"Q","to":"dw"}]');
    expect(host.saveSettings.mock.calls).toEqual([
      [true],
      [true],
      ...Array.from({ length: 9 }, () => [false]),
    ]);
  });

  it.each([
    ["escapeSequences", "[", "invalid escape JSON"],
    ["escapeSequences", '["jj","jjk"]', "ambiguous escape prefixes"],
    ["escapeSequences", "{}", "a non-array escape value"],
    ["escapeSequences", "[12]", "non-string escape entries"],
    ["escapeTimeoutMs", "0", "a zero timeout"],
    ["escapeTimeoutMs", "-1", "a negative timeout"],
    ["escapeTimeoutMs", "NaN", "a non-numeric timeout"],
    ["escapeTimeoutMs", "Infinity", "an infinite timeout"],
    ["keyBindings", "[", "invalid mapping JSON"],
    [
      "keyBindings",
      '[{"mode":"normal","from":"Q","to":"Z"},{"mode":"normal","from":"Z","to":"Q"}]',
      "cyclic mappings",
    ],
  ])("rejects %s with %s (%s) before mutation or persistence", async (key, value) => {
    const { host, tab } = setup({
      escapeSequences: ["jk"],
      escapeTimeoutMs: 350,
      keyBindings: [{ mode: "normal", from: "Q", to: "dw" }],
    });
    const before = structuredClone(host.settings);
    const escapeSequences = host.settings.escapeSequences;
    const keyBindings = host.settings.keyBindings;
    await expect(tab.setControlValue(key, value)).rejects.toThrow();
    expect(host.settings).toEqual(before);
    expect(host.settings.escapeSequences).toBe(escapeSequences);
    expect(host.settings.keyBindings).toBe(keyBindings);
    expect(host.saveSettings).not.toHaveBeenCalled();
    expect(tab.refreshDomState).not.toHaveBeenCalled();
  });

  it("provides inline validators that do not save or replace values", () => {
    const { host, tab } = setup({ escapeSequences: ["jk"], escapeTimeoutMs: 350 });
    const escapes = control(tab, "escapeSequences");
    const timeout = control(tab, "escapeTimeoutMs");
    if (escapes.type !== "textarea" || timeout.type !== "text")
      throw new Error("Escape settings must expose text validators.");
    expect(escapes.validate?.('["jj","jjk"]')).toEqual(expect.any(String));
    expect(escapes.validate?.('["jj","jk"]')).toBeUndefined();
    expect(timeout.validate?.("0")).toEqual(expect.any(String));
    expect(timeout.validate?.("500")).toBeUndefined();
    expect(host.settings.escapeSequences).toEqual(["jk"]);
    expect(host.settings.escapeTimeoutMs).toBe(350);
    expect(host.saveSettings).not.toHaveBeenCalled();
  });

  it("preserves unsupported mappings and refreshes their warning through the custom editor", async () => {
    const { host, tab } = setup();
    const unsupported = [{ mode: "normal", from: "Z", to: ":write<CR>" }];
    await tab.setControlValue("keyBindings", JSON.stringify(unsupported));
    expect(host.settings.keyBindings).toEqual(unsupported);
    const definition = rows(tab).find((item) => item.render);
    if (!definition?.render) throw new Error("Missing mapping editor.");
    const issues = document.createElement("div");
    let currentText = "";
    let onChange: ((value: string) => void | Promise<void>) | undefined;
    const input = {
      setValue(value: string) {
        currentText = value;
        return input;
      },
      onChange(callback: (value: string) => void | Promise<void>) {
        onChange = callback;
        return input;
      },
    };
    definition.render(
      {
        descEl: { createDiv: () => issues },
        addTextArea: (callback: (component: typeof input) => void) => callback(input),
      } as unknown as Setting,
      {} as SettingGroup,
    );
    expect(JSON.parse(currentText)).toEqual(unsupported);
    expect(issues.textContent).toContain("normal: Z → :write<CR>");
    expect(issues.textContent).toContain("未対応");
    if (!onChange) throw new Error("The mapping editor did not register its change handler.");
    const before = structuredClone(host.settings);
    host.saveSettings.mockClear();
    await onChange("[");
    expect(issues.textContent).not.toBe("");
    expect(host.settings).toEqual(before);
    expect(host.saveSettings).not.toHaveBeenCalled();
    await onChange('[{"mode":"normal","from":"Q","to":"dw"}]');
    expect(host.settings.keyBindings).toEqual([{ mode: "normal", from: "Q", to: "dw" }]);
    expect(issues.textContent).toBe("");
    expect(host.saveSettings).toHaveBeenCalledExactlyOnceWith(false);
  });
});
