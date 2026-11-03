import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { loadSettings } from "../src/settings";
import { NativePendingHints, nativeHintEntries } from "../src/engines/builtin/hints";
import type { NativeCM, NativeState, NativeVim } from "../src/engines/builtin/native";
import type { BackendHost } from "../src/engines/types";

describe("native passive hints", () => {
  const state = (prefix: string): NativeState => ({
    inputState: { keyBuffer: [prefix], getRepeat: () => 1 },
    sel: { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } },
  });

  it("describes buffered native prefixes without executing or completing them", () => {
    const current = state("g");
    const before = structuredClone({ keys: current.inputState.keyBuffer });
    const entries = nativeHintEntries(current, loadSettings({ engine: "builtin" }));
    expect(entries.some(({ key }) => key === "?")).toBe(true);
    expect(entries.some(({ key }) => key === "j")).toBe(true);
    expect(current.inputState.keyBuffer).toEqual(before.keys);
    current.insertMode = true;
    expect(nativeHintEntries(current, loadSettings({}))).toEqual([]);
  });

  it("cancels delayed overlays on unload and while composition owns input", () => {
    vi.useFakeTimers();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: EditorState.create({ doc: "text" }), parent });
    view.focus();
    const cm = { cm6: view, state: { vim: state("g") } } as NativeCM;
    const settings = loadSettings({ engine: "builtin" });
    const host = { settings: () => settings, isActive: () => true } as BackendHost;
    const vim = {} as NativeVim;
    const hints = new NativePendingHints(cm, vim, host);
    try {
      hints.refresh();
      vi.advanceTimersByTime(550);
      expect(parent.querySelector(".lindvimera-pending-hints")?.textContent).toContain("ROT13");
      settings.showPendingHints = false;
      hints.refresh();
      vi.advanceTimersByTime(550);
      expect(parent.querySelector(".lindvimera-pending-hints")).toBeNull();
      settings.showPendingHints = true;
      hints.refresh();
      hints.destroy();
      vi.advanceTimersByTime(550);
      expect(parent.querySelector(".lindvimera-pending-hints")).toBeNull();
    } finally {
      hints.destroy();
      view.destroy();
      parent.remove();
      vi.useRealTimers();
    }
  });
});
