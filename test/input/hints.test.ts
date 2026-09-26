import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undoDepth } from "@codemirror/commands";
import { getCM, Vim } from "@replit/codemirror-vim";
import { editorSession, lindvimeraEditor } from "../../src/runtime/editor";
import { pendingHintEntries } from "../../src/input/hints";
import { getGuideEntries } from "../../src/input/catalog";
import { DEFAULT_SETTINGS, type KeyBinding } from "../../src/settings";
import { NativeHostFixture } from "../table/host-fixture";

const views: EditorView[] = [];
beforeEach(() => {
  Vim.resetVimGlobalState_();
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
});
function setup() {
  const settings = { ...DEFAULT_SETTINGS, keyBindings: [] as KeyBinding[] };
  let ui: "none" | "suggestion" | "blocked" = "none";
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: "# Heading\nalpha beta\n",
      extensions: [
        history(),
        lindvimeraEditor({ settings: () => settings, owner: () => undefined, inputUI: () => ui }),
      ],
    }),
  });
  views.push(view);
  view.focus();
  const cm = getCM(view)!;
  return {
    view,
    cm,
    settings,
    ui: (next: typeof ui) => {
      ui = next;
    },
  };
}
function keys(cm: ReturnType<typeof setup>["cm"], sequence: string) {
  for (const key of sequence.match(/<[^>]+>|./gu) ?? [])
    cm.operation(() => Vim.handleKey(cm, key, "user"));
}
function physical(view: EditorView, key: string) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

describe("read-only command continuations", () => {
  it.each(["g", "d", "di", "gu", '"a2d', "ysiw", "f"])(
    "does not mutate input, macro, selection or history for %s",
    (sequence) => {
      const { cm, view } = setup();
      keys(cm, sequence);
      const input = cm.state.vim!.inputState;
      const before = JSON.stringify({
        input,
        literal: cm.state.vim!.expectLiteralNext,
        selection: view.state.selection.toJSON(),
        macro: Vim.getVimGlobalState_().macroModeState,
        text: cm.getValue(),
        register: Vim.getRegisterController().getRegister('"').toString(),
        undo: undoDepth(view.state),
      });
      expect(pendingHintEntries(cm).length).toBeGreaterThan(0);
      expect(cm.state.vim!.inputState).toBe(input);
      expect(
        JSON.stringify({
          input,
          literal: cm.state.vim!.expectLiteralNext,
          selection: view.state.selection.toJSON(),
          macro: Vim.getVimGlobalState_().macroModeState,
          text: cm.getValue(),
          register: Vim.getRegisterController().getRegister('"').toString(),
          undo: undoDepth(view.state),
        }),
      ).toBe(before);
    },
  );
  it("filters objects and preserves mapping priority", () => {
    const { cm, settings } = setup();
    keys(cm, "di");
    const initial = pendingHintEntries(cm).map((entry) => entry.key);
    expect(initial).toContain("h");
    expect(initial).toContain("L");
    expect(initial).not.toContain("t");
    settings.textObjects = false;
    editorSession(cm.cm6)!.configure();
    expect(pendingHintEntries(cm).map((entry) => entry.key)).not.toContain("h");
    keys(cm, "<Esc>");
    settings.keyBindings = [{ mode: "normal", from: "gq", to: "dw" }];
    Vim.map("gq", "dw", "normal");
    try {
      keys(cm, "g");
      expect(pendingHintEntries(cm).find((entry) => entry.key === "q")?.label).toContain("dw");
    } finally {
      Vim.unmap("gq", "normal");
    }
  });
  it("does not suggest a conflicting operator after d", () => {
    const { cm } = setup();
    keys(cm, "d");
    const hints = pendingHintEntries(cm);
    expect(hints.some((entry) => entry.key === "d")).toBe(true);
    expect(hints.some((entry) => entry.key === "c" || entry.key === "y")).toBe(false);
  });
});

describe("passive pending overlay", () => {
  it("appears after 500ms, caps eight items, and disappears on completion", () => {
    const { view } = setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    physical(view, "d");
    vi.advanceTimersByTime(499);
    expect(view.dom.querySelector(".lindvimera-pending-hints")).toBeNull();
    vi.advanceTimersByTime(1);
    expect(view.dom.querySelectorAll(".lindvimera-pending-hints kbd")).toHaveLength(8);
    expect(view.contentDOM).toBe(document.activeElement);
    physical(view, "w");
    expect(view.dom.querySelector(".lindvimera-pending-hints")).toBeNull();
  });
  it.each(["Escape", "compositionstart", "focusout"])("cancels stale display on %s", (event) => {
    const { view } = setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    physical(view, "g");
    if (event === "Escape") physical(view, event);
    else view.contentDOM.dispatchEvent(new Event(event, { bubbles: true }));
    vi.advanceTimersByTime(550);
    expect(view.dom.querySelector(".lindvimera-pending-hints")).toBeNull();
  });
  it("suppresses counts, host UI, recording, and disabled hints", () => {
    const { cm, view, settings, ui } = setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    physical(view, "2");
    vi.advanceTimersByTime(500);
    expect(view.dom.querySelector(".lindvimera-pending-hints")).toBeNull();
    physical(view, "d");
    ui("suggestion");
    vi.advanceTimersByTime(500);
    expect(view.dom.querySelector(".lindvimera-pending-hints")).toBeNull();
    ui("none");
    keys(cm, "<Esc>qa");
    physical(view, "d");
    vi.advanceTimersByTime(500);
    expect(view.dom.querySelector(".lindvimera-pending-hints")).toBeNull();
    keys(cm, "<Esc>q");
    settings.showPendingHints = false;
    physical(view, "g");
    vi.advanceTimersByTime(500);
    expect(view.dom.querySelector(".lindvimera-pending-hints")).toBeNull();
  });
});

it("describes feature-disabled and unsupported saved entries without deleting them", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    folding: false,
    keyBindings: [{ mode: "normal" as const, from: "Q", to: ":write<CR>" }],
  };
  const entries = getGuideEntries(settings);
  expect(entries.find((entry) => entry.keys === "za")?.enabled).toBe(false);
  expect(entries.find((entry) => entry.keys === "Q")?.reason).toContain("未対応");
  expect(entries.find((entry) => entry.keys === "ah")?.description).toContain("祖先");
  expect(settings.keyBindings).toHaveLength(1);
});

describe("dispatcher and guide regression cases", () => {
  it.each(["ysiw)", "ds)", "cs)'", "yss)"])(
    "disables a mapping to %s when Surround is disabled",
    (to) => {
      const settings = {
        ...DEFAULT_SETTINGS,
        surround: false,
        keyBindings: [{ mode: "normal" as const, from: "Q", to }],
      };
      const entry = getGuideEntries(settings).find((candidate) => candidate.keys === "Q");
      expect(entry?.enabled).toBe(false);
      expect(entry?.reason).toContain("無効");
    },
  );

  it("describes the actual doubled operator when its final key also has a mapping", () => {
    const { cm, settings, view } = setup();
    settings.keyBindings = [{ mode: "operatorPending", from: "u", to: "w" }];
    Vim.map("u", "w", "operatorPending");
    try {
      keys(cm, "gu");
      const candidate = pendingHintEntries(cm).find((entry) => entry.key === "u");
      expect(candidate).toBeDefined();
      expect(candidate!.label).not.toContain("割り当て");
      keys(cm, "u");
      expect(view.state.doc.line(1).text).toBe("# heading");
    } finally {
      Vim.unmap("u", "operatorPending");
    }
  });

  it("retains custom continuations alongside local-mark name guidance", () => {
    const { cm, settings } = setup();
    settings.keyBindings = [{ mode: "normal", from: "mZ", to: "w" }];
    Vim.map("mZ", "w", "normal");
    try {
      keys(cm, "m");
      expect(pendingHintEntries(cm).find((entry) => entry.key === "Z")?.label).toContain("w");
      keys(cm, "Z");
      expect(cm.getCursor().ch).toBe(2);
    } finally {
      Vim.unmap("mZ", "normal");
    }
  });

  it("omits body-only text objects in a native cell while retaining cell objects", () => {
    const host = new NativeHostFixture("| A | B |\n| --- | --- |\n| one | two |");
    try {
      host.keys("di");
      const continuations = pendingHintEntries(host.engine).map((entry) => entry.key);
      expect(continuations).toContain("w");
      expect(continuations).toContain("l");
      expect(continuations).not.toContain("h");
      expect(continuations).not.toContain("L");
    } finally {
      host.destroy();
    }
  });

  it("describes Visual o/O as selection endpoint movement rather than insertion", () => {
    const entries = getGuideEntries(DEFAULT_SETTINGS);
    for (const keys of ["o", "O"]) {
      const entry = entries.find(
        (candidate) => candidate.keys === keys && candidate.modes.includes("visual"),
      );
      expect(entry?.description).toContain("選択");
      expect(entry?.description).not.toContain("挿入");
    }
  });

  it("explains disabled feature targets through direct and transitive mappings", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      folding: false,
      keyBindings: [
        { mode: "normal" as const, from: "Q", to: "W" },
        { mode: "normal" as const, from: "W", to: "za" },
      ],
    };
    const entries = getGuideEntries(settings);
    for (const keys of ["Q", "W"]) {
      const entry = entries.find(
        (candidate) => candidate.keys === keys && candidate.category === "ユーザー割り当て",
      );
      expect(entry?.enabled).toBe(false);
      expect(entry?.reason).toContain("無効");
    }
  });
});
