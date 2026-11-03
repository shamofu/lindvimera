import { describe, expect, it, vi } from "vitest";
import type { App, Setting, SettingDefinition, SettingGroup } from "obsidian";
import { LindvimeraSettingTab } from "../src/settings-tab";
import { loadSettings, type LindvimeraSettings } from "../src/settings";
import { defaultEngine, engineRegistry } from "../src/engines/registry";

vi.mock("obsidian", () => ({
  PluginSettingTab: class {
    refreshDomState = vi.fn();
  },
}));
vi.mock("../src/ui/guide", () => ({ openCommandGuide: vi.fn() }));

function setup(initial: Partial<LindvimeraSettings> = {}) {
  const host = {
    settings: loadSettings(initial),
    builtinVim: vi.fn(() => false),
    engineConflict: vi.fn(() => false),
    engineNeedsReload: vi.fn(() => false),
    selectEngine: vi.fn(async (engine: "embedded" | "builtin") => {
      host.settings.engine = engine;
    }),
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
      "engine",
      "enabled",
      "japanese",
      "linderaMode",
      "markdownMotions",
      "markdownEditing",
      "textObjects",
      "surround",
      "tables",
      "folding",
      "showStatus",
      "showPendingHints",
      "escapeSequences",
      "escapeTimeoutMs",
    ]);
    for (const definition of definitions) {
      expect(definition.name.trim()).not.toBe("");
      expect(definition.searchable).not.toBe(false);
    }
    expect(
      definitions.find((definition) => definition.name === "モード別キー割り当て")?.render,
    ).toBeTypeOf("function");
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
    host.engineConflict.mockReturnValue(true);
    expect(warning.visible()).toBe(true);
  });
});

describe("settings persistence", () => {
  it("persists the engine through the reload-only path without applying live mappings", async () => {
    const { host, tab } = setup();
    expect(tab.getControlValue("engine")).toBe(defaultEngine);
    const choice = engineRegistry.at(-1)!.id;
    await tab.setControlValue("engine", choice);
    expect(host.settings.engine).toBe(choice);
    expect(host.selectEngine).toHaveBeenCalledWith(choice);
    expect(host.saveSettings).not.toHaveBeenCalled();
  });
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
      "markdownEditing",
      "textObjects",
      "surround",
      "tables",
      "folding",
      "showStatus",
      "showPendingHints",
    ])
      await tab.setControlValue(key, false);
    await tab.setControlValue("escapeSequences", '["jk"]');
    await tab.setControlValue("escapeTimeoutMs", "300");
    await tab.setControlValue("keyBindings", '[{"mode":"normal","from":"Q","to":"dw"}]');
    expect(host.saveSettings.mock.calls).toEqual([
      [true],
      [true],
      ...Array.from({ length: 12 }, () => [false]),
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

  it("restores previous mappings and reapplies them when persistence rejects", async () => {
    const original = [{ mode: "normal" as const, from: "Q", to: "dw" }];
    const { host, tab } = setup({ keyBindings: original });
    const previous = host.settings.keyBindings;
    const observed: unknown[] = [];
    host.saveSettings.mockImplementation(async () => {
      observed.push(structuredClone(host.settings.keyBindings));
      throw new Error("disk unavailable");
    });
    await expect(
      tab.setControlValue("keyBindings", '[{"mode":"normal","from":"Q","to":"yw"}]'),
    ).rejects.toThrow("disk unavailable");
    expect(host.settings.keyBindings).toBe(previous);
    expect(observed).toEqual([[{ mode: "normal", from: "Q", to: "yw" }], original]);
    expect(tab.refreshDomState).not.toHaveBeenCalled();
  });

  it("preserves unsupported mappings and refreshes their warning through the custom editor", async () => {
    const { host, tab } = setup({ folding: false });
    const unsupported = [{ mode: "normal", from: "Z", to: "za" }];
    await tab.setControlValue("keyBindings", JSON.stringify(unsupported));
    expect(host.settings.keyBindings).toEqual(unsupported);
    const definition = rows(tab).find((item) => item.name === "モード別キー割り当て");
    if (!definition?.render) throw new Error("Missing mapping editor.");
    const element = document.createElement("div");
    definition.render(
      {
        settingEl: element,
        controlEl: element,
      } as unknown as Setting,
      {} as SettingGroup,
    );
    expect(element.querySelector("textarea")).toBeNull();
    expect(element.textContent).toContain("無効");
    const inputs = element.querySelectorAll("input");
    expect(inputs[0].value).toBe("Z");
    expect(inputs[1].value).toBe("za");
    const before = structuredClone(host.settings);
    host.saveSettings.mockClear();
    inputs[1].value = "dw";
    inputs[1].dispatchEvent(new Event("input"));
    expect(host.settings).toEqual(before);
    expect(host.saveSettings).not.toHaveBeenCalled();
    const apply = Array.from(element.querySelectorAll("button")).find(
      (button) => button.textContent === "適用",
    );
    apply!.click();
    await vi.waitFor(() => expect(host.saveSettings).toHaveBeenCalledOnce());
    expect(host.settings.keyBindings).toEqual([{ mode: "normal", from: "Z", to: "dw" }]);
    expect(element.querySelector(".lindvimera-setting-error")?.textContent).toBe("");
    expect(host.saveSettings).toHaveBeenCalledExactlyOnceWith(false);
  });
});

function renderCursor(tab: LindvimeraSettingTab) {
  const definition = rows(tab).find((item) => item.name === "カーソルの色");
  if (!definition?.render) throw new Error("Missing cursor color setting.");
  expect(definition.searchable).not.toBe(false);
  const settingEl = document.createElement("div");
  const controlEl = document.createElement("div");
  const description = document.createElement("div");
  settingEl.append(description, controlEl);
  description.textContent = typeof definition.desc === "string" ? definition.desc : "";
  // Obsidian is not executable in jsdom. Keep native component event/value/disabled
  // behavior at this boundary while running the real setting render and persistence.
  const setting = {
    settingEl,
    controlEl,
    setDesc(value: string) {
      description.textContent = value;
      return setting;
    },
    addColorPicker(callback: (component: unknown) => void) {
      const input = document.createElement("input");
      input.type = "color";
      controlEl.append(input);
      const component = {
        colorPickerEl: input,
        setValue(value: string) {
          input.value = value;
          return component;
        },
        setDisabled(value: boolean) {
          input.disabled = value;
          return component;
        },
        onChange(handler: (value: string) => void) {
          input.addEventListener("input", () => handler(input.value));
          return component;
        },
      };
      callback(component);
      return setting;
    },
    addButton(callback: (component: unknown) => void) {
      const button = document.createElement("button");
      controlEl.append(button);
      const component = {
        buttonEl: button,
        setButtonText(value: string) {
          button.textContent = value;
          return component;
        },
        setDisabled(value: boolean) {
          button.disabled = value;
          return component;
        },
        onClick(handler: () => void) {
          button.addEventListener("click", handler);
          return component;
        },
      };
      callback(component);
      return setting;
    },
  };
  definition.render(setting as unknown as Setting, {} as SettingGroup);
  return {
    settingEl,
    description,
    picker: controlEl.querySelector("input[type=color]") as HTMLInputElement,
    reset: Array.from(controlEl.querySelectorAll("button")).find(
      (button) => button.textContent === "既定に戻す",
    )!,
  };
}

describe("cursor color settings", () => {
  it("persists normalized colors and a null reset with an editor refresh that does not flush input", async () => {
    const { host, tab } = setup();
    await tab.setControlValue("cursorColor", "#A1B2C3");
    expect(tab.getControlValue("cursorColor")).toBe("#a1b2c3");
    expect(loadSettings(JSON.parse(JSON.stringify(host.settings)))).toHaveProperty(
      "cursorColor",
      "#a1b2c3",
    );
    await tab.setControlValue("cursorColor", null);
    expect(host.settings).toHaveProperty("cursorColor", null);
    expect(host.saveSettings.mock.calls).toEqual([[true], [true]]);
  });

  it.each(["", "red", "#abc", "#11223344", " #112233", "#gg1122", 123, undefined])(
    "rejects malformed new cursor color %s before mutation",
    async (value) => {
      const { host, tab } = setup();
      const before = structuredClone(host.settings);
      await expect(tab.setControlValue("cursorColor", value)).rejects.toThrow();
      expect(host.settings).toEqual(before);
      expect(host.saveSettings).not.toHaveBeenCalled();
    },
  );

  it("keeps the native picker and reset state synchronized after changes and reset", async () => {
    const { host, tab } = setup();
    const ui = renderCursor(tab);
    expect(ui.picker.value).toBe("#ff9696");
    expect(ui.reset.disabled).toBe(true);
    expect(ui.description.textContent).toContain("既存の色");
    ui.picker.value = "#123abc";
    ui.picker.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(host.settings).toHaveProperty("cursorColor", "#123abc"));
    await vi.waitFor(() => expect(ui.reset.disabled).toBe(false));
    expect(ui.picker.disabled).toBe(false);
    ui.reset.click();
    await vi.waitFor(() => expect(host.settings).toHaveProperty("cursorColor", null));
    await vi.waitFor(() => expect(ui.picker.value).toBe("#ff9696"));
    expect(ui.reset.disabled).toBe(true);
    expect(ui.description.textContent).toContain("既存の色");
    await tab.setControlValue("cursorColor", "#abcdef");
    expect(ui.picker.value).toBe("#abcdef");
    expect(ui.reset.disabled).toBe(false);
  });

  it.each(["picker", "reset"] as const)(
    "restores settings and controls after a failed %s save",
    async (action) => {
      const { host, tab } = setup({ cursorColor: "#123abc" });
      const ui = renderCursor(tab);
      host.saveSettings.mockRejectedValueOnce(new Error("disk unavailable"));
      if (action === "picker") {
        ui.picker.value = "#abcdef";
        ui.picker.dispatchEvent(new Event("input"));
      } else ui.reset.click();
      await vi.waitFor(() => expect(ui.settingEl.textContent).toContain("disk unavailable"));
      expect(host.settings).toHaveProperty("cursorColor", "#123abc");
      expect(ui.picker.value).toBe("#123abc");
      expect(ui.picker.disabled).toBe(false);
      expect(ui.reset.disabled).toBe(false);
      host.saveSettings.mockResolvedValue(undefined);
      ui.reset.click();
      await vi.waitFor(() => expect(ui.reset.disabled).toBe(true));
      expect(host.settings).toHaveProperty("cursorColor", null);
      expect(ui.settingEl.textContent).not.toContain("disk unavailable");
    },
  );
});

it("saves the Markdown line editing toggle independently from Markdown motions", async () => {
  const { host, tab } = setup({ markdownMotions: false });
  const definition = rows(tab).find((row) => row.control?.key === "markdownEditing");
  expect(definition?.name).toBe("Markdownに合わせた行追加・行頭操作");
  expect(definition?.control?.type).toBe("toggle");
  expect(tab.getControlValue("markdownEditing")).toBe(true);
  await tab.setControlValue("markdownEditing", false);
  expect(loadSettings(JSON.parse(JSON.stringify(host.settings)))).toMatchObject({
    markdownEditing: false,
    markdownMotions: false,
  });
  expect(host.saveSettings).toHaveBeenCalledExactlyOnceWith(false);
  await expect(tab.setControlValue("markdownEditing", "false")).rejects.toThrow();
  expect(host.settings.markdownEditing).toBe(false);
  expect(host.saveSettings).toHaveBeenCalledTimes(1);
});
