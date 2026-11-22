import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { createBackend } from "../src/engines/builtin";
import { analyseKeyBindings } from "../src/engines/builtin/policy";
import {
  getNativeCM,
  getNativeVim,
  withMappings,
  type NativeCM,
  type NativeCommand,
  type NativeVim,
  type NativeWindow,
} from "../src/engines/builtin/native";
import { DEFAULT_SETTINGS, type LindvimeraSettings } from "../src/settings";
import { parseMarkdownTable } from "../src/table/source";
import { budouxSegmenter } from "../src/word";
import type { BackendHost } from "../src/engines/types";

vi.mock("obsidian", () => ({ Scope: class {} }));

function fakeNative() {
  const commands: NativeCommand[] = [];
  const motions = new Map();
  const actions = new Map();
  const operators = new Map();
  const macroModeState: {
    isRecording?: boolean;
    latestRegister?: string;
    isPlaying?: boolean;
    replaySearchQueries: unknown[];
  } = {
    isRecording: false,
    latestRegister: undefined,
    isPlaying: false,
    replaySearchQueries: [],
  };
  const findKey = vi.fn<NativeVim["findKey"]>(() => vi.fn(() => true));
  const vim = {
    findKey,
    handleKey(cm: NativeCM, key: string, origin?: string) {
      return this.findKey(cm, key, origin)?.();
    },
    defineMotion: vi.fn((name, callback) => motions.set(name, callback)),
    defineAction: vi.fn((name, callback) => actions.set(name, callback)),
    defineOperator: vi.fn((name, callback) => operators.set(name, callback)),
    _mapCommand: vi.fn((command) => commands.unshift(command)),
    unmap: vi.fn((keys, context) => {
      const at = commands.findIndex((c) => c.keys === keys && c.context === context);
      if (at >= 0) commands.splice(at, 1);
      return at >= 0;
    }),
    exitVisualMode: vi.fn(),
    getRegisterController: () => ({
      getRegister: () => ({ keyBuffer: [], insertModeChanges: [], searchQueries: [] }),
    }),
    getVimGlobalState_: () => ({ macroModeState }),
  } satisfies NativeVim;
  return { vim, commands, motions, actions, operators, findKey, macroModeState };
}

const cmEmitters = new WeakMap<NativeCM, (event: string, ...args: unknown[]) => void>();

function emitCM(cm: NativeCM, event: string, ...args: unknown[]): void {
  cmEmitters.get(cm)?.(event, ...args);
}

function nativeCM(view: EditorView): NativeCM {
  let cursor = { line: 0, ch: 0 };
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const cm: NativeCM = {
    cm6: view,
    state: {
      vim: {
        inputState: { keyBuffer: [], getRepeat: () => 1 },
        sel: { anchor: cursor, head: cursor },
      },
    },
    getValue: () => view.state.doc.toString(),
    getLine: (line) => view.state.doc.line(line + 1).text,
    firstLine: () => 0,
    lastLine: () => view.state.doc.lines - 1,
    getCursor: () => cursor,
    setCursor: (value, ch) => {
      cursor = typeof value === "number" ? { line: value, ch: ch ?? 0 } : value;
    },
    setSelections: vi.fn(),
    indexFromPos: (value) => view.state.doc.line(value.line + 1).from + value.ch,
    posFromIndex: (value) => {
      const line = view.state.doc.lineAt(value);
      return { line: line.number - 1, ch: value - line.from };
    },
    replaceRange(text, from, to = from) {
      view.dispatch({
        changes: { from: this.indexFromPos(from), to: this.indexFromPos(to), insert: text },
      });
    },
    operation: (action) => action(),
    on: vi.fn((event, callback) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(callback);
    }),
    off: vi.fn((event, callback) => {
      listeners.get(event)?.delete(callback);
    }),
  };
  cmEmitters.set(cm, (event, ...args) => {
    for (const callback of listeners.get(event) ?? []) callback(...args);
  });
  (view as EditorView & { cm: NativeCM }).cm = cm;
  return cm;
}

const cleanup: (() => void)[] = [];
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  delete (window as NativeWindow).CodeMirrorAdapter;
});

async function setup() {
  const native = fakeNative();
  (window as NativeWindow).CodeMirrorAdapter = { Vim: native.vim };
  let extension: Extension = [];
  let active = true;
  const settings: LindvimeraSettings = {
    ...DEFAULT_SETTINGS,
    keyBindings: [],
    escapeSequences: [],
  };
  const host: BackendHost = {
    app: {} as BackendHost["app"],
    settings: () => settings,
    wordSegmenter: () => budouxSegmenter,
    isActive: () => active,
    reportMode: vi.fn(),
    reportError: vi.fn(),
    registerEditorExtension: (value) => {
      extension = value;
    },
  };
  const backend = createBackend(host);
  cleanup.push(() => backend.dispose());
  const view = new EditorView({
    state: EditorState.create({
      doc: "日本語の文章を読みます。次です。\n**bold**",
      extensions: extension,
    }),
    parent: document.body,
  });
  cleanup.push(() => view.destroy());
  const cm = nativeCM(view);
  await Promise.resolve();
  return {
    ...native,
    cm,
    view,
    extension,
    host,
    backend,
    settings,
    suspend: () => {
      active = false;
      backend.refresh();
    },
    activate: () => {
      active = true;
      backend.refresh();
    },
  };
}

describe("builtin ownership boundary", () => {
  it("accepts native syntax outside the embedded curated catalog, validates duplicate/cycle structure", () => {
    expect(
      analyseKeyBindings([{ mode: "normal", from: "Q", to: ":set relativenumber<CR>" }]).active,
    ).toHaveLength(1);
    const result = analyseKeyBindings([
      { mode: "normal", from: "x", to: "y" },
      { mode: "normal", from: "y", to: "x" },
      { mode: "normal", from: "x", to: "z" },
    ]);
    expect(result.active).toHaveLength(0);
    expect(result.issues).toHaveLength(3);
    const first = { mode: "normal" as const, from: "Q", to: "Zj" };
    const second = { mode: "normal" as const, from: "Z", to: "Qw" };
    expect(analyseKeyBindings([first, second]).issues.map((issue) => issue.binding)).toEqual(
      expect.arrayContaining([first, second]),
    );
  });

  it("requires the real CM6 adapter identity and ignores legacy CodeMirror.Vim", () => {
    const fake = { CodeMirror: { Vim: fakeNative().vim } } as unknown as Window;
    expect(getNativeVim(fake)).toBeUndefined();
    expect(getNativeCM({ cm: { cm6: {} } } as unknown as EditorView)).toBeUndefined();
  });

  it("removes its exact mapping after a nested foreign replacement and on exceptions", () => {
    const native = fakeNative();
    const foreign: NativeCommand = {
      keys: "w",
      context: "normal",
      type: "motion",
      motion: "foreign",
    };
    const own: NativeCommand = { keys: "w", context: "normal", type: "motion", motion: "owned" };
    expect(() =>
      withMappings(native.vim, [own], () => {
        native.vim._mapCommand(foreign);
        throw new Error("lookup failed");
      }),
    ).toThrow("lookup failed");
    expect(native.commands).toEqual([foreign]);
    expect(own.context).toBe("normal");
  });

  it("delegates native dispatch, suspends additions, restores only its wrapper", async () => {
    const test = await setup();
    test.vim.handleKey(test.cm, "w");
    expect(test.findKey).toHaveBeenCalledWith(test.cm, "w", undefined);
    expect(test.commands).toEqual([]);
    expect(test.vim._mapCommand).toHaveBeenCalled();
    test.vim._mapCommand.mockClear();
    test.suspend();
    test.vim.handleKey(test.cm, "w");
    expect(test.vim._mapCommand).not.toHaveBeenCalled();
    const originalState = test.cm.state.vim;
    test.backend.dispose();
    expect(test.vim.findKey).toBe(test.findKey);
    expect(test.cm.state.vim).toBe(originalState);
    expect(test.cm.off).toHaveBeenCalledWith("vim-mode-change", expect.any(Function));
  });

  it("does not clobber a later foreign findKey wrapper or retain active addon callbacks", async () => {
    const test = await setup();
    const owned = test.vim.findKey;
    const foreign = vi.fn((cm: NativeCM, key: string) => owned.call(test.vim, cm, key));
    test.vim.findKey = foreign;
    test.backend.dispose();
    expect(test.vim.findKey).toBe(foreign);
    const motion = test.motions.get("lindvimera115_word");
    expect(
      motion(
        test.cm,
        { line: 0, ch: 0 },
        { repeat: 1, forward: true },
        test.cm.state.vim,
        test.cm.state.vim!.inputState,
      ),
    ).toBeUndefined();
  });

  it("exposes the native identities and keeps parent/cell input states independent", async () => {
    const test = await setup();
    const runtime = test.backend.runtime as {
      Vim: NativeVim;
      getCM(view: EditorView): NativeCM;
      editorSession(view: EditorView): { cm: NativeCM; state: unknown };
      status(): { editors: number };
    };
    expect(runtime.Vim).toBe(test.vim);
    expect(runtime.getCM(test.view)).toBe(test.cm);
    expect(runtime.editorSession(test.view).state).toBe(test.cm.state.vim);
    expect(runtime.status().editors).toBe(1);
    const cellView = new EditorView({ state: test.view.state, parent: document.body });
    cleanup.push(() => cellView.destroy());
    const cell = nativeCM(cellView);
    await Promise.resolve();
    expect(runtime.status().editors).toBe(2);
    expect(runtime.editorSession(cellView).cm).toBe(cell);
    expect(runtime.editorSession(cellView).state).not.toBe(test.cm.state.vim);
  });

  it("normalizes native operator ranges in place so combining marks are not left behind", async () => {
    const test = await setup();
    test.view.dispatch({
      changes: { from: 0, to: test.view.state.doc.length, insert: "か\u3099 次" },
    });
    const ranges = [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 1 } }];
    test.cm.setSelections!(ranges);
    expect(ranges[0].head.ch).toBe(2);
    test.suspend();
    const nativeRange = [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 1 } }];
    test.cm.setSelections!(nativeRange);
    expect(nativeRange[0].head.ch).toBe(1);
  });

  it("does not convert a user-mapped operator-pending s into surround", async () => {
    const test = await setup();
    test.settings.keyBindings = [{ mode: "operatorPending", from: "s", to: "e" }];
    test.backend.applySettings();
    test.cm.state.vim!.inputState.operator = "delete";
    test.vim.handleKey(test.cm, "s");
    expect(test.cm.state.vim!.inputState.operator).toBe("delete");
  });

  it("does not attach a view destroyed before its queued initialization", async () => {
    const test = await setup();
    const doomed = new EditorView({ state: test.view.state, parent: document.body });
    nativeCM(doomed);
    doomed.destroy();
    await Promise.resolve();
    const runtime = test.backend.runtime as { status(): { editors: number } };
    expect(runtime.status().editors).toBe(1);
  });

  it("reanalyses feature-dependent mappings when a feature is toggled", async () => {
    const test = await setup();
    test.settings.keyBindings = [{ mode: "normal", from: "Q", to: "ysiw)" }];
    test.backend.applySettings();
    let mapped = false;
    test.findKey.mockImplementation(() => {
      mapped = test.commands.some((command) => command.keys === "Q");
      return () => true;
    });
    test.vim.handleKey(test.cm, "Q");
    expect(mapped).toBe(true);
    test.settings.surround = false;
    test.backend.applySettings();
    test.vim.handleKey(test.cm, "Q");
    expect(mapped).toBe(false);
  });

  it("handles Live Preview decorations, gj/gk, W/B/E/gE, exactTarget _x-snap guard, and cleanup", async () => {
    const native = fakeNative();
    (window as NativeWindow).CodeMirrorAdapter = { Vim: native.vim };
    let extension: Extension = [];
    const settings: LindvimeraSettings = {
      ...DEFAULT_SETTINGS,
      keyBindings: [],
      escapeSequences: [],
    };
    const backend = createBackend({
      app: {} as BackendHost["app"],
      settings: () => settings,
      wordSegmenter: () => budouxSegmenter,
      isActive: () => true,
      reportMode: vi.fn(),
      reportError: vi.fn(),
      registerEditorExtension: (value) => {
        extension = value;
      },
    });
    cleanup.push(() => backend.dispose());

    class InsWidget extends WidgetType {
      toDOM(): HTMLElement {
        const el = document.createElement("span");
        el.className = "cm-html-embed";
        el.innerHTML = "<ins>def</ins>";
        return el;
      }
    }

    const decoField = StateField.define<DecorationSet>({
      create: (state) => buildDecos(state),
      update: (v, tr) => (tr.docChanged || tr.selection ? buildDecos(tr.state) : v),
      provide: (f) => EditorView.decorations.from(f),
    });
    function buildDecos(state: EditorState): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const head = state.selection.main.head;
      const line0 = state.doc.line(1);
      // Line 0: "abc**def**ghi" -> collapse "**" unless cursor is inside [3, 10)
      if (!(head >= 3 && head < 10)) {
        builder.add(3, 5, Decoration.replace({}));
        builder.add(8, 10, Decoration.replace({}));
      }
      // Line 1: "<ins>def</ins> xyz" -> collapse unless cursor is inside [l1, l1+14)
      const line1 = state.doc.line(2);
      if (!(head >= line1.from && head < line1.from + 14)) {
        builder.add(line1.from, line1.from + 14, Decoration.replace({ widget: new InsWidget() }));
      }
      void line0;
      return builder.finish();
    }

    const container = document.createElement("div");
    container.className = "markdown-source-view is-live-preview";
    document.body.appendChild(container);
    cleanup.push(() => container.remove());

    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: "abc**def**ghi\n<ins>def</ins> xyz01",
        extensions: [decoField, extension],
      }),
    });
    cleanup.push(() => view.destroy());

    let cursor = { line: 0, ch: 2 };
    let sawPreDispatched = false;
    const rawSetCursor = vi.fn((pos: { line: number; ch: number } | number, ch?: number) => {
      const target = typeof pos === "number" ? { line: pos, ch: ch ?? 0 } : pos;
      // Simulate Obsidian CodeMirrorAdapter._x: snaps ch 5 back to opening '*' (ch 3)
      // unless CM6 selection was already dispatched to offset 5 before setCursor runs!
      if (view.state.selection.main.head === cm.indexFromPos(target)) {
        sawPreDispatched = true;
        cursor = target;
      } else {
        cursor = target.ch === 5 ? { line: target.line, ch: 3 } : target;
      }
    });
    const cm: NativeCM = {
      cm6: view,
      state: {
        vim: {
          inputState: { keyBuffer: [], getRepeat: () => 1 },
          sel: { anchor: cursor, head: cursor },
        },
      },
      getValue: () => view.state.doc.toString(),
      getLine: (line) => view.state.doc.line(line + 1).text,
      firstLine: () => 0,
      lastLine: () => view.state.doc.lines - 1,
      getCursor: () => cursor,
      setCursor: rawSetCursor,
      setSelections: vi.fn(),
      findPosV: (head, amount) => ({
        line: Math.max(0, Math.min(view.state.doc.lines - 1, head.line + amount)),
        ch: head.ch,
      }),
      charCoords: (pos) => ({ left: pos.ch * 8 }),
      indexFromPos: (value) => view.state.doc.line(value.line + 1).from + value.ch,
      posFromIndex: (value) => {
        const line = view.state.doc.lineAt(value);
        return { line: line.number - 1, ch: value - line.from };
      },
      replaceRange: vi.fn(),
      operation: (action) => action(),
      on: vi.fn(),
      off: vi.fn(),
    };
    (view as EditorView & { cm: NativeCM }).cm = cm;
    await Promise.resolve();

    // commands() exposes j/k, gj/gk, W/B/E/gE, ^ in Live Preview Normal mode
    let captured: NativeCommand[] = [];
    native.findKey.mockImplementation(() => {
      captured = [...native.commands];
      return () => true;
    });
    native.vim.handleKey(cm, "l");
    expect(
      captured.some((c) => c.keys === "gj" && c.motion === "lindvimera115_displayVertical"),
    ).toBe(true);
    expect(captured.some((c) => c.keys === "W" && c.motion === "lindvimera115_word")).toBe(true);
    expect(captured.some((c) => c.keys === "^" && c.motion === "lindvimera115_contentStart")).toBe(
      true,
    );

    const charMotion = native.motions.get("lindvimera115_character")!;
    const wordMotion = native.motions.get("lindvimera115_word")!;
    const startMotion = native.motions.get("lindvimera115_contentStart")!;
    const vertMotion = native.motions.get("lindvimera115_contentVertical")!;
    const dispMotion = native.motions.get("lindvimera115_displayVertical")!;

    // Normal 'l' from ch 2 ('c') skips collapsed '**' to ch 5 ('d') and avoids _x snap!
    const lTarget = charMotion(
      cm,
      { line: 0, ch: 2 },
      { repeat: 1, forward: true },
      cm.state.vim,
      cm.state.vim!.inputState,
    );
    expect(lTarget).toEqual({ line: 0, ch: 5 });
    cm.setCursor(lTarget);
    expect(sawPreDispatched).toBe(true);
    expect(cm.getCursor()).toEqual({ line: 0, ch: 5 });

    // Once expanded inside [3, 10), 'h' steps 1 char into closing '*' of '**'
    const hExpanded = charMotion(
      cm,
      { line: 0, ch: 5 },
      { repeat: 1, forward: false },
      cm.state.vim,
      cm.state.vim!.inputState,
    );
    expect(hExpanded).toEqual({ line: 0, ch: 4 });

    // Back at ch 0 -> '^' on line 1 (<ins>def</ins>) skips '<ins>' -> ch 5
    view.dispatch({ selection: { anchor: 0 } });
    expect(
      startMotion(cm, { line: 1, ch: 0 }, { repeat: 1 }, cm.state.vim, cm.state.vim!.inputState),
    ).toEqual({ line: 1, ch: 5 });

    // '$' (lastHPos = Infinity) -> 'h' -> 'j' resets lastHPos (does not jump to last char of line 1!)
    cm.state.vim!.lastHPos = Infinity;
    const afterH = charMotion(
      cm,
      { line: 0, ch: 12 },
      { repeat: 1, forward: false },
      cm.state.vim,
      cm.state.vim!.inputState,
    );
    expect(afterH).toEqual({ line: 0, ch: 11 });
    expect(cm.state.vim!.lastHPos).toBe(11);
    const jFromH = vertMotion(
      cm,
      afterH,
      { repeat: 1, forward: true, linewise: true },
      cm.state.vim,
      cm.state.vim!.inputState,
    );
    expect(jFromH).toEqual({ line: 1, ch: 18 });
    cm.state.vim!.lastHPos = Infinity;
    const afterW = wordMotion(
      cm,
      { line: 0, ch: 0 },
      { repeat: 1, forward: true, bigWord: true },
      cm.state.vim,
      cm.state.vim!.inputState,
    );
    expect(cm.state.vim!.lastHPos).toBe(afterW.ch);

    // Consecutive j -> j preserves goal across short/collapsed lines
    const firstJ = vertMotion(
      cm,
      { line: 0, ch: 2 },
      { repeat: 1, forward: true, linewise: true },
      cm.state.vim,
      cm.state.vim!.inputState,
    );
    expect(firstJ).toEqual({ line: 1, ch: 7 }); // 'f' in <ins>def</ins> (col 2)
    const backK = vertMotion(
      cm,
      firstJ,
      { repeat: 1, forward: false, linewise: true },
      cm.state.vim,
      cm.state.vim!.inputState,
    );
    expect(backK).toEqual({ line: 0, ch: 2 });

    // displayVertical (gj) lands inside .cm-html-embed at the visual X column
    view.contentDOM.getBoundingClientRect = () => new DOMRect(100, 0, 400, 100);
    view.coordsAtPos = (offset) => new DOMRect(100, offset >= 14 ? 20 : 0, 1, 16);
    const embedEl = view.contentDOM.querySelector(".cm-html-embed") as HTMLElement;
    embedEl.getBoundingClientRect = () => new DOMRect(100, 20, 30, 16);
    const origCreateRange = document.createRange.bind(document);
    const origCreateRangeProp = document.createRange;
    document.createRange = () => {
      const range = origCreateRange();
      let startOffset = 0;
      const origSetStart = range.setStart.bind(range);
      range.setStart = (node, offset) => {
        startOffset = offset;
        origSetStart(node, offset);
      };
      range.getClientRects = () =>
        [new DOMRect(100 + startOffset * 10, 20, 10, 16)] as unknown as DOMRectList;
      return range;
    };
    cleanup.push(() => {
      document.createRange = origCreateRangeProp;
    });
    const gjRes = dispMotion(
      cm,
      { line: 0, ch: 1 },
      { repeat: 1, forward: true },
      cm.state.vim,
      cm.state.vim!.inputState,
    );
    expect(gjRes).toEqual({ line: 1, ch: 6 });

    // operatorPending, visualBlock, and Source mode bypass Live Preview adjustment
    expect(
      charMotion(cm, { line: 0, ch: 2 }, { repeat: 1, forward: true }, cm.state.vim, {
        operator: "delete",
      }),
    ).toEqual({ line: 0, ch: 3 });

    cm.state.vim!.visualBlock = true;
    expect(
      charMotion(cm, { line: 0, ch: 2 }, { repeat: 1, forward: true }, cm.state.vim, {}),
    ).toEqual({ line: 0, ch: 3 });
    cm.state.vim!.visualBlock = false;

    container.classList.remove("is-live-preview");
    expect(
      charMotion(cm, { line: 0, ch: 2 }, { repeat: 1, forward: true }, cm.state.vim, {}),
    ).toEqual({ line: 0, ch: 3 });

    // dispose() restores original cm.setCursor
    backend.dispose();
    expect(cm.setCursor).toBe(rawSetCursor);
  });

  it("synchronizes lindvimera-custom-cursor across settings, suspension, multi-view, and cleanup", async () => {
    const test = await setup();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);
    expect(test.view.dom.style.getPropertyValue("--lindvimera-cursor-color")).toBe("");

    test.settings.cursorColor = "#123abc";
    test.backend.applySettings();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);
    expect(test.view.dom.style.getPropertyValue("--lindvimera-cursor-color")).toBe("#123abc");

    const cellView = new EditorView({
      state: EditorState.create({ doc: "cell", extensions: test.extension }),
      parent: document.body,
    });
    cleanup.push(() => cellView.destroy());
    nativeCM(cellView);
    await Promise.resolve();
    expect(cellView.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);
    expect(cellView.dom.style.getPropertyValue("--lindvimera-cursor-color")).toBe("#123abc");

    test.suspend();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);
    expect(test.view.dom.style.getPropertyValue("--lindvimera-cursor-color")).toBe("");
    expect(cellView.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);
    expect(cellView.dom.style.getPropertyValue("--lindvimera-cursor-color")).toBe("");

    test.activate();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);
    expect(test.view.dom.style.getPropertyValue("--lindvimera-cursor-color")).toBe("#123abc");
    expect(cellView.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);
    expect(cellView.dom.style.getPropertyValue("--lindvimera-cursor-color")).toBe("#123abc");

    test.settings.cursorColor = null;
    test.backend.applySettings();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);
    expect(test.view.dom.style.getPropertyValue("--lindvimera-cursor-color")).toBe("");
    expect(cellView.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);
    expect(cellView.dom.style.getPropertyValue("--lindvimera-cursor-color")).toBe("");

    test.settings.cursorColor = "#abcdef";
    test.backend.applySettings();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);
    expect(cellView.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);

    cellView.destroy();
    expect(cellView.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);
    expect(cellView.dom.style.getPropertyValue("--lindvimera-cursor-color")).toBe("");
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);

    test.backend.dispose();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);
    expect(test.view.dom.style.getPropertyValue("--lindvimera-cursor-color")).toBe("");
  });

  it("retains lindvimera-custom-cursor across focus/blur and editorAttributes updates, and omits it when inactive, null, or disposed", async () => {
    const test = await setup();
    test.settings.cursorColor = "#123abc";
    test.backend.applySettings();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);

    // Focus then blur with CM6 dispatch to trigger updateAttrs().
    test.view.focus();
    test.view.dispatch({});
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);

    test.view.contentDOM.blur();
    test.view.dispatch({});
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);

    // Appending external EditorView.editorAttributes (e.g. theme classes) preserves custom cursor.
    test.view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.editorAttributes.of({ class: "theme-cursor" }),
      ),
    });
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);
    expect(test.view.dom.classList.contains("theme-cursor")).toBe(true);

    // Suspended: attribute refreshes must not re-add the class.
    test.suspend();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);
    test.view.focus();
    test.view.dispatch({
      effects: StateEffect.appendConfig.of(EditorView.editorAttributes.of({ class: "extra-cls" })),
    });
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);
    expect(test.view.dom.classList.contains("extra-cls")).toBe(true);

    // Reactivate then clear cursorColor: attribute refreshes keep it absent.
    test.activate();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);
    test.settings.cursorColor = null;
    test.backend.applySettings();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);
    test.view.contentDOM.blur();
    test.view.dispatch({});
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);

    // Disposed: attribute refreshes never re-add the class.
    test.settings.cursorColor = "#abcdef";
    test.backend.applySettings();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(true);
    test.backend.dispose();
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);
    test.view.focus();
    test.view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.editorAttributes.of({ class: "after-dispose" }),
      ),
    });
    expect(test.view.dom.classList.contains("lindvimera-custom-cursor")).toBe(false);
    expect(test.view.dom.classList.contains("after-dispose")).toBe(true);
  });

  it("reports REPLACE, visual modes, pending keys, vim-command-done clearing, and macro recording", async () => {
    const test = await setup();
    const reportMode = vi.mocked(test.host.reportMode);
    test.view.focus();
    const vimState = test.cm.state.vim!;

    test.backend.applySettings();
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL");

    vimState.insertMode = true;
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("INSERT");

    test.cm.state.overwrite = true;
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("REPLACE");
    test.backend.applySettings();
    expect(reportMode).toHaveBeenLastCalledWith("REPLACE");

    // Stale overwrite flag while not in insertMode must report NORMAL, not REPLACE.
    vimState.insertMode = false;
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL");
    test.cm.state.overwrite = false;

    vimState.visualMode = true;
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("VISUAL");

    vimState.visualLine = true;
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("VISUAL LINE");

    vimState.visualLine = false;
    vimState.visualBlock = true;
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("VISUAL BLOCK");

    vimState.visualMode = false;
    vimState.visualBlock = false;
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL");

    // Pending keys via inputState and command wrapper.
    vimState.inputState = { keyBuffer: ["2"], getRepeat: () => 2 };
    test.vim.handleKey(test.cm, "2");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL · 2");

    vimState.inputState = {
      keyBuffer: [],
      prefixRepeat: ["2"],
      operator: "delete",
      getRepeat: () => 2,
    };
    test.vim.handleKey(test.cm, "d");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL · 2d");

    vimState.inputState = {
      keyBuffer: [],
      registerName: "a",
      getRepeat: () => 1,
    };
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith('NORMAL · "a');

    vimState.inputState = {
      keyBuffer: [],
      operator: "indent",
      operatorArgs: { repeat: 1, indentRight: true },
      getRepeat: () => 1,
    };
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL · >");

    vimState.inputState = {
      keyBuffer: [],
      operator: "changeCase",
      operatorShortcut: "gu",
      getRepeat: () => 1,
    };
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL · gu");

    vimState.inputState = {
      keyBuffer: [],
      operator: "lindvimera115_surroundAdd",
      getRepeat: () => 1,
    };
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL · ys");

    vimState.inputState = { keyBuffer: [], getRepeat: () => 1 };
    vimState.expectLiteralNext = true;
    vimState.status = "ysiw";
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL · ysiw");

    vimState.status = undefined;
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL");
    vimState.expectLiteralNext = false;

    // Pending keys clear via vim-command-done even when findKey returns undefined.
    vimState.inputState = { keyBuffer: ["d"], getRepeat: () => 1 };
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL · d");

    test.findKey.mockImplementationOnce(() => {
      vimState.inputState = { keyBuffer: [], getRepeat: () => 1 };
      emitCM(test.cm, "vim-command-done");
      return undefined;
    });
    test.vim.handleKey(test.cm, "<C-z>");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL");

    // Macro recording status alone, combined with pending keys, missing register, and stopped.
    test.macroModeState.isRecording = true;
    test.macroModeState.latestRegister = "a";
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL · recording @a");

    vimState.inputState = { keyBuffer: [], operator: "delete", getRepeat: () => 1 };
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL · d · recording @a");

    vimState.inputState = { keyBuffer: [], getRepeat: () => 1 };
    test.macroModeState.isRecording = false;
    emitCM(test.cm, "vim-command-done");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL");

    test.macroModeState.isRecording = true;
    test.macroModeState.latestRegister = undefined;
    emitCM(test.cm, "vim-mode-change");
    expect(reportMode).toHaveBeenLastCalledWith("NORMAL");

    test.backend.dispose();
    expect(test.cm.off).toHaveBeenCalledWith("vim-command-done", expect.any(Function));
  });

  it("restricts [t/]t to Normal mode and exits Visual mode before focusing adjacent cell on Tab/S-Tab", async () => {
    const native = fakeNative();
    (window as NativeWindow).CodeMirrorAdapter = { Vim: native.vim };
    let extension: Extension = [];
    const docText = "before\n\n| a | b |\n| --- | --- |\n| c | d |\n\nafter";
    const tableStart = docText.indexOf("| a |");
    const tableEnd = docText.indexOf("| d |") + "| d |".length;
    const events: string[] = [];

    interface MockCell {
      row: number;
      col: number;
      text: string;
      table: MockTable;
      getAbsoluteOffsets(): { start: number; end: number; textStart: number; textEnd: number };
    }
    interface MockTable {
      start: number;
      end: number;
      rows: MockCell[][];
      editor: MockEditMode;
      getCellAt(row: number, column: number): MockCell | null;
      deselectCells: ReturnType<typeof vi.fn>;
    }
    interface MockEditMode {
      cm: EditorView;
      tableCell: { cell: MockCell; table: MockTable; cm: EditorView } | null;
      editTableCell: (
        table: MockTable,
        cell: MockCell,
      ) => { cell: MockCell; table: MockTable; cm: EditorView };
      destroyTableCell: ReturnType<typeof vi.fn>;
    }

    let editMode!: MockEditMode;
    const host: BackendHost = {
      app: {
        workspace: {
          iterateAllLeaves: (callback: (leaf: { view: { editMode: MockEditMode } }) => void) =>
            callback({ view: { editMode } }),
        },
      } as unknown as BackendHost["app"],
      settings: () => ({ ...DEFAULT_SETTINGS, keyBindings: [], escapeSequences: [] }),
      wordSegmenter: () => budouxSegmenter,
      isActive: () => true,
      reportMode: vi.fn(),
      reportError: vi.fn(),
      registerEditorExtension: (value) => {
        extension = value;
      },
    };
    const backend = createBackend(host);
    cleanup.push(() => backend.dispose());

    const parentView = new EditorView({
      state: EditorState.create({ doc: docText, extensions: extension }),
      parent: document.body,
    });
    cleanup.push(() => parentView.destroy());
    nativeCM(parentView);

    const parsed = parseMarkdownTable(docText.slice(tableStart, tableEnd), tableStart);
    const table: MockTable = {
      start: tableStart,
      end: tableEnd,
      rows: [],
      editor: null as unknown as MockEditMode,
      getCellAt: (row, column) => table.rows[row]?.[column] ?? null,
      deselectCells: vi.fn(),
    };
    table.rows = parsed.rows.map((row) =>
      row.map((cell) => ({
        row: cell.row,
        col: cell.column,
        text: cell.map.source,
        table,
        getAbsoluteOffsets: () => ({
          start: cell.from,
          end: cell.to,
          textStart: cell.content.from,
          textEnd: cell.content.to,
        }),
      })),
    );

    const widget = document.createElement("div");
    widget.className = "cm-table-widget";
    parentView.dom.appendChild(widget);

    let cellView!: EditorView;
    let cellCM!: NativeCM;
    const openCell = (cell: MockCell) => {
      if (cellView) cellView.destroy();
      cellView = new EditorView({
        state: EditorState.create({ doc: cell.text.trim(), extensions: extension }),
        parent: widget,
      });
      cellCM = nativeCM(cellView);
      const entry = { cell, table, cm: cellView };
      editMode.tableCell = entry;
      return entry;
    };

    editMode = {
      cm: parentView,
      tableCell: null,
      editTableCell: vi.fn((_table: MockTable, cell: MockCell) => {
        events.push("editTableCell");
        return openCell(cell);
      }),
      destroyTableCell: vi.fn(() => {
        if (cellView) cellView.destroy();
        editMode.tableCell = null;
      }),
    };
    table.editor = editMode;
    openCell(table.rows[0][0]);
    cleanup.push(() => cellView?.destroy());
    await Promise.resolve();

    let captured: NativeCommand[] = [];
    native.findKey.mockImplementation(() => {
      captured = [...native.commands];
      return () => true;
    });
    native.vim.handleKey(cellCM, "<Tab>");

    expect(captured.filter((c) => c.keys === "[t").map((c) => c.context)).toEqual(["normal"]);
    expect(captured.filter((c) => c.keys === "]t").map((c) => c.context)).toEqual(["normal"]);
    expect(
      captured
        .filter((c) => c.keys === "<Tab>")
        .map((c) => c.context)
        .sort(),
    ).toEqual(["normal", "visual"]);
    expect(
      captured
        .filter((c) => c.keys === "<S-Tab>")
        .map((c) => c.context)
        .sort(),
    ).toEqual(["normal", "visual"]);

    native.vim.exitVisualMode.mockImplementation(() => {
      events.push("exitVisualMode");
    });

    const tableMove = native.actions.get("lindvimera115_tableMove")!;
    const firstCM = cellCM;
    firstCM.state.vim!.visualMode = true;
    tableMove(firstCM, { forward: true, repeat: 1 });
    await (backend.runtime as { settled(): Promise<void> }).settled();

    expect(native.vim.exitVisualMode).toHaveBeenCalledWith(firstCM, false);
    expect(events).toEqual(["exitVisualMode", "editTableCell"]);
    expect(editMode.tableCell?.cell).toMatchObject({ row: 0, col: 1 });

    await Promise.resolve();
    events.length = 0;
    native.vim.exitVisualMode.mockClear();
    const secondCM = cellCM;
    secondCM.state.vim!.visualMode = true;
    tableMove(secondCM, { forward: false, repeat: 1 });
    await (backend.runtime as { settled(): Promise<void> }).settled();

    expect(native.vim.exitVisualMode).toHaveBeenCalledWith(secondCM, false);
    expect(events).toEqual(["exitVisualMode", "editTableCell"]);
    expect(editMode.tableCell?.cell).toMatchObject({ row: 0, col: 0 });

    await Promise.resolve();
    const tableLeave = native.actions.get("lindvimera115_tableLeave")!;
    tableLeave(cellCM, { forward: false, repeat: 1 });
    await (backend.runtime as { settled(): Promise<void> }).settled();
    expect(table.deselectCells).toHaveBeenCalled();
    expect(editMode.destroyTableCell).toHaveBeenCalled();
    expect(parentView.state.selection.main.head).toBe("before\n".length);

    openCell(table.rows[0][0]);
    await Promise.resolve();
    tableLeave(cellCM, { forward: true, repeat: 1 });
    await (backend.runtime as { settled(): Promise<void> }).settled();
    expect(parentView.state.selection.main.head).toBe(tableEnd + 1);

    // Boundary moves (<S-Tab> at (0, 0) and <Tab> at last cell (1, 1)) must be no-ops in
    // both Visual and Normal modes: zero calls to exitVisualMode or editTableCell.
    const editTableCellSpy = vi.mocked(editMode.editTableCell);

    openCell(table.rows[0][0]);
    await Promise.resolve();
    editTableCellSpy.mockClear();
    native.vim.exitVisualMode.mockClear();
    cellCM.state.vim!.visualMode = true;
    tableMove(cellCM, { forward: false, repeat: 1 });
    await (backend.runtime as { settled(): Promise<void> }).settled();
    expect(native.vim.exitVisualMode).not.toHaveBeenCalled();
    expect(editTableCellSpy).not.toHaveBeenCalled();
    expect(editMode.tableCell?.cell).toMatchObject({ row: 0, col: 0 });

    cellCM.state.vim!.visualMode = false;
    tableMove(cellCM, { forward: false, repeat: 1 });
    await (backend.runtime as { settled(): Promise<void> }).settled();
    expect(native.vim.exitVisualMode).not.toHaveBeenCalled();
    expect(editTableCellSpy).not.toHaveBeenCalled();
    expect(editMode.tableCell?.cell).toMatchObject({ row: 0, col: 0 });

    openCell(table.rows[1][1]);
    await Promise.resolve();
    editTableCellSpy.mockClear();
    native.vim.exitVisualMode.mockClear();
    cellCM.state.vim!.visualMode = true;
    tableMove(cellCM, { forward: true, repeat: 1 });
    await (backend.runtime as { settled(): Promise<void> }).settled();
    tableMove(cellCM, { forward: true, repeat: 5 });
    await (backend.runtime as { settled(): Promise<void> }).settled();
    expect(native.vim.exitVisualMode).not.toHaveBeenCalled();
    expect(editTableCellSpy).not.toHaveBeenCalled();
    expect(editMode.tableCell?.cell).toMatchObject({ row: 1, col: 1 });

    cellCM.state.vim!.visualMode = false;
    tableMove(cellCM, { forward: true, repeat: 1 });
    await (backend.runtime as { settled(): Promise<void> }).settled();
    expect(native.vim.exitVisualMode).not.toHaveBeenCalled();
    expect(editTableCellSpy).not.toHaveBeenCalled();
    expect(editMode.tableCell?.cell).toMatchObject({ row: 1, col: 1 });
  });
});
