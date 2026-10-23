import { expect, it } from "vitest";
import { checkedKeyBindings, DEFAULT_SETTINGS, loadSettings } from "../src/settings";

it("ignores the obsolete probe flag without losing production settings", () => {
  const settings = loadSettings({ probeEnabled: true, japanese: false, escapeSequences: ["jj"] });
  expect(settings).not.toHaveProperty("probeEnabled");
  expect(settings).toMatchObject({ japanese: false, escapeSequences: ["jj"] });
});

it("enables the implementation by default and recovers invalid persisted options", () => {
  expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  expect(
    loadSettings({ escapeSequences: ["j", "jj"], escapeTimeoutMs: -1 }).escapeSequences,
  ).toEqual([]);
  expect(loadSettings({ escapeSequences: [] }).escapeSequences).toEqual([]);
  expect(loadSettings({ japanese: false, tables: false }).japanese).toBe(false);
  const a = loadSettings(null);
  a.escapeSequences.push("jk");
  a.keyBindings.push({ mode: "normal", from: "j", to: "gj" });
  expect(loadSettings(null).escapeSequences).toEqual([]);
  expect(loadSettings(null).keyBindings).toEqual([]);
  expect(DEFAULT_SETTINGS.escapeSequences).toEqual([]);
  expect(DEFAULT_SETTINGS.keyBindings).toEqual([]);
});

it("preserves explicit escape sequences and mappings from saved settings", () => {
  const saved = {
    escapeSequences: ["jj", "jk"],
    escapeTimeoutMs: 350,
    keyBindings: [{ mode: "normal", from: "j", to: "gj" }],
  };
  const loaded = loadSettings(saved);
  expect(loaded.escapeSequences).toEqual(saved.escapeSequences);
  expect(loaded.escapeTimeoutMs).toBe(350);
  expect(loaded.keyBindings).toEqual(saved.keyBindings);
  loaded.escapeSequences.push("kk");
  loaded.keyBindings[0].to = "gk";
  expect(saved.escapeSequences).toEqual(["jj", "jk"]);
  expect(saved.keyBindings[0].to).toBe("gj");
});

it("validates per-mode mappings and rejects ambiguity and recursion", () => {
  expect(checkedKeyBindings([{ mode: "normal", from: "j", to: "gj" }])).toHaveLength(1);
  expect(() => checkedKeyBindings([{ mode: "normal", from: "j", to: "j" }])).toThrow(/循環/);
  expect(() =>
    checkedKeyBindings([
      { mode: "normal", from: "j", to: "k" },
      { mode: "normal", from: "k", to: "j" },
    ]),
  ).toThrow(/循環/);
  expect(() =>
    checkedKeyBindings([
      { mode: "normal", from: "j", to: "gj" },
      { mode: "normal", from: "j", to: "k" },
    ]),
  ).toThrow(/重複/);
});

it("restores both Lindera modes, defaults invalid values to normal and retains mode while disabled", () => {
  for (const mode of [undefined, null, "", "invalid", 1, "normal"])
    expect(loadSettings({ linderaMode: mode }).linderaMode).toBe("normal");
  for (const mode of ["normal", "decompose"] as const) {
    const saved = JSON.parse(JSON.stringify({ japanese: false, linderaMode: mode }));
    expect(loadSettings(saved)).toMatchObject({ japanese: false, linderaMode: mode });
  }
});

it("defaults Markdown line editing for older or invalid saved settings and retains explicit false", () => {
  for (const markdownEditing of [undefined, null, "false", 0, {}, []])
    expect(loadSettings({ markdownEditing }).markdownEditing).toBe(true);
  expect(loadSettings({}).markdownEditing).toBe(true);
  expect(loadSettings({ markdownEditing: true }).markdownEditing).toBe(true);
  expect(loadSettings({ markdownEditing: false }).markdownEditing).toBe(false);
});

it("restores a six-digit cursor color in lowercase and preserves the default for old or invalid data", () => {
  expect(loadSettings({ cursorColor: "#A1B2C3" })).toHaveProperty("cursorColor", "#a1b2c3");
  expect(loadSettings({ cursorColor: "#000000" })).toHaveProperty("cursorColor", "#000000");
  for (const value of [undefined, null, "", "#abc", "red", "#11223344", " #112233", 123, {}])
    expect(loadSettings({ cursorColor: value })).toHaveProperty("cursorColor", null);
  expect(loadSettings({})).toHaveProperty("cursorColor", null);
});
