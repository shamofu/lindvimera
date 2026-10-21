import { describe, expect, it } from "vitest";
import { getGuideEntries, type CommandGuideEntry } from "../../src/input/catalog";
import { loadSettings, type VimMode } from "../../src/settings";

function builtin(entries: CommandGuideEntry[], keys: string, mode: VimMode = "normal") {
  const entry = entries.find(
    (candidate) =>
      candidate.keys === keys &&
      candidate.modes.includes(mode) &&
      candidate.category !== "ユーザー割り当て",
  );
  if (!entry) throw new Error(`Missing guide entry ${mode}:${keys}`);
  return entry;
}

describe("guide mapping availability", () => {
  it("marks longer commands shadowed by a complete mapping in the same mode", () => {
    const entries = getGuideEntries(
      loadSettings({ keyBindings: [{ mode: "normal", from: "g", to: "w" }] }),
    );
    for (const keys of ["gf", "gg", "gJ", "gU"]) {
      expect(builtin(entries, keys).enabled).toBe(false);
      expect(builtin(entries, keys).reason).toContain("ユーザー割り当て");
    }
    expect(builtin(entries, "gg", "visual").enabled).toBe(true);
    expect(builtin(entries, "w").enabled).toBe(true);
    expect(
      entries.find((entry) => entry.keys === "g" && entry.category === "ユーザー割り当て")?.enabled,
    ).toBe(true);
  });

  it("handles literal templates and complete special-key tokens without over-disabling", () => {
    const entries = getGuideEntries(
      loadSettings({
        keyBindings: [
          { mode: "normal", from: "f", to: "w" },
          { mode: "normal", from: "<C-f>", to: "w" },
          { mode: "normal", from: "gg", to: "w" },
        ],
      }),
    );
    expect(builtin(entries, "f<character>").enabled).toBe(false);
    expect(builtin(entries, "<C-f>").enabled).toBe(false);
    expect(builtin(entries, "F<character>").enabled).toBe(true);
    expect(builtin(entries, "<C-b>").enabled).toBe(true);
    expect(builtin(entries, "gf").enabled).toBe(true);
    const literalOnly = getGuideEntries(
      loadSettings({ keyBindings: [{ mode: "normal", from: "fa", to: "w" }] }),
    );
    expect(builtin(literalOnly, "f<character>").enabled).toBe(true);
  });

  it("marks a longer user mapping shadowed and ignores disabled prefix definitions", () => {
    const entries = getGuideEntries(
      loadSettings({
        keyBindings: [
          { mode: "normal", from: "g", to: "w" },
          { mode: "normal", from: "gf", to: "dw" },
        ],
      }),
    );
    expect(
      entries.find((entry) => entry.keys === "gf" && entry.category === "ユーザー割り当て")?.reason,
    ).toContain("短いユーザー割り当て");
    const disabled = getGuideEntries(
      loadSettings({ keyBindings: [{ mode: "normal", from: "g", to: ":write<CR>" }] }),
    );
    expect(builtin(disabled, "gf").enabled).toBe(true);
  });

  it("shows native backtick mappings as enabled with Markdown objects switched off", () => {
    const entries = getGuideEntries(
      loadSettings({ textObjects: false, keyBindings: [{ mode: "normal", from: "Q", to: "di`" }] }),
    );
    expect(entries.find((entry) => entry.keys === "Q")?.enabled).toBe(true);
    expect(
      entries
        .filter((entry) => entry.keys === "i`" && entry.modes.includes("operatorPending"))
        .some((entry) => entry.enabled),
    ).toBe(true);
  });
});

describe("Markdown line editing guidance", () => {
  it("describes Markdown body motions and Normal insertions only when enabled", () => {
    const markdown = getGuideEntries(loadSettings({ markdownEditing: true }));
    const standard = getGuideEntries(loadSettings({ markdownEditing: false }));
    for (const mode of ["normal", "visual", "operatorPending"] as const) {
      expect(builtin(markdown, "^", mode).description).toContain("Markdown");
      expect(builtin(standard, "^", mode).description).toContain("最初の非空白文字");
      expect(builtin(standard, "^", mode).description).not.toContain("Markdown");
    }
    for (const keys of ["I", "o", "O"]) {
      expect(builtin(markdown, keys).description).toContain("Markdown");
      expect(builtin(standard, keys).description).not.toContain("Markdown");
      expect(builtin(standard, keys).enabled).toBe(true);
    }
    for (const keys of ["I", "o", "O"]) {
      expect(builtin(markdown, keys, "visual")).toEqual(builtin(standard, keys, "visual"));
      expect(builtin(markdown, keys, "visual").description).not.toContain("Markdown");
    }
  });

  it("keeps standard Vim mapping targets available when Markdown line editing is off", () => {
    const entries = getGuideEntries(
      loadSettings({
        markdownEditing: false,
        keyBindings: [{ mode: "normal", from: "o", to: "O" }],
      }),
    );
    expect(builtin(entries, "o").reason).toContain("ユーザー割り当て");
    expect(builtin(entries, "O").enabled).toBe(true);
    expect(
      entries.find((entry) => entry.keys === "o" && entry.category === "ユーザー割り当て")?.enabled,
    ).toBe(true);
  });
});
