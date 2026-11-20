import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorState, RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
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
import { budouxSegmenter } from "../src/word";
import type { BackendHost } from "../src/engines/types";

vi.mock("obsidian", () => ({ Scope: class {} }));

function fakeNative() {
  const commands: NativeCommand[] = [];
  const motions = new Map();
  const actions = new Map();
  const operators = new Map();
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
    getVimGlobalState_: () => ({ macroModeState: { replaySearchQueries: [] } }),
  } satisfies NativeVim;
  return { vim, commands, motions, actions, operators, findKey };
}

function nativeCM(view: EditorView): NativeCM {
  let cursor = { line: 0, ch: 0 };
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
    on: vi.fn(),
    off: vi.fn(),
  };
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
    host,
    backend,
    settings,
    suspend: () => {
      active = false;
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
});
