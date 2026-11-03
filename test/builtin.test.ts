// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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
    setCursor: (value) => {
      cursor = value;
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
});
