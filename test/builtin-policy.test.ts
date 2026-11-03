import { describe, expect, it } from "vitest";
import { analyseKeyBindings } from "../src/engines/builtin/policy";
import { loadSettings } from "../src/settings";

describe("native mapping grammar", () => {
  it.each(["gj", "gk"])(
    "does not confuse the suffix of %s with a recursive single-key map",
    (to) => {
      const binding = { mode: "normal" as const, from: to.slice(1), to };
      expect(analyseKeyBindings([binding]).active).toEqual([binding]);
    },
  );
  it.each(["iQ<Esc>", "/Q<CR>", '"Qyw', "fQ", "rQ", ":s/Q/done/<CR>"])(
    "does not treat a literal in %s as a mapping dependency",
    (to) => {
      const binding = { mode: "normal" as const, from: "Q", to };
      expect(analyseKeyBindings([binding]).active).toEqual([binding]);
    },
  );
  it("retains native quote objects and typed extension names when Markdown objects are off", () => {
    const settings = loadSettings({ textObjects: false, surround: false, folding: false });
    const bindings = [
      { mode: "normal" as const, from: "Q", to: "di`" },
      { mode: "normal" as const, from: "Z", to: "izacs<Esc>" },
    ];
    expect(analyseKeyBindings(bindings, settings).active).toEqual(bindings);
  });
  it("detects a cycle through a later complete command and disables dependents", () => {
    const bindings = [
      { mode: "normal" as const, from: "Q", to: "jZ" },
      { mode: "normal" as const, from: "Z", to: "kQ" },
      { mode: "normal" as const, from: "T", to: "Q" },
    ];
    expect(analyseKeyBindings(bindings).active).toEqual([]);
  });
});
