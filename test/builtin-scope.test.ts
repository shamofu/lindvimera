import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeNavigationScope } from "../src/engines/builtin/scope";
import type { BackendHost } from "../src/engines/types";
import type { NativeCM, NativeWindow } from "../src/engines/builtin/native";

vi.mock("obsidian", () => ({
  Scope: class {
    handlers: ((event: KeyboardEvent) => unknown)[] = [];
    register(_modifiers: unknown, _key: unknown, callback: (event: KeyboardEvent) => unknown) {
      this.handlers.push(callback);
      return callback;
    }
    unregister(callback: (event: KeyboardEvent) => unknown) {
      this.handlers = this.handlers.filter((handler) => handler !== callback);
    }
  },
}));

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  delete (window as NativeWindow).CodeMirrorAdapter;
});

function setup() {
  const view = new EditorView({
    state: EditorState.create({ doc: "first\nlast" }),
    parent: document.body,
  });
  cleanup.push(() => view.destroy());
  const cm = {
    cm6: view,
    state: { vim: { insertMode: false, visualMode: false } },
  } as unknown as NativeCM;
  Object.assign(view, { cm });
  const handleKey = vi.fn();
  (window as NativeWindow).CodeMirrorAdapter = {
    Vim: {
      handleKey,
      findKey: vi.fn(),
      _mapCommand: vi.fn(),
      unmap: vi.fn(),
      defineAction: vi.fn(),
      defineMotion: vi.fn(),
      defineOperator: vi.fn(),
      getRegisterController: vi.fn(),
      getVimGlobalState_: vi.fn(),
      exitVisualMode: vi.fn(),
    },
  };
  const parent = {};
  const documentView = {
    scope: parent as { handlers: ((event: KeyboardEvent) => unknown)[] },
    editMode: { cm: view, editorSuggest: { isShowingSuggestion: () => false } },
  };
  let active = true;
  const scope = new NativeNavigationScope({
    app: {
      workspace: {
        iterateAllLeaves: (visit: (leaf: object) => void) => visit({ view: documentView }),
      },
    },
    isActive: () => active,
  } as unknown as BackendHost);
  cleanup.push(() => scope.dispose());
  scope.refresh();
  view.focus();
  const dispatch = (options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: "o",
      ctrlKey: true,
      cancelable: true,
      ...options,
    });
    const result = documentView.scope.handlers[0]?.(event);
    return { event, result };
  };
  return {
    view,
    cm,
    scope,
    documentView,
    parent,
    handleKey,
    dispatch,
    suspend: () => {
      active = false;
    },
  };
}

describe("native jump scope", () => {
  it("dispatches focused Normal-mode Ctrl-o/i exactly once before application shortcuts", () => {
    const test = setup();
    expect(test.dispatch().result).toBe(false);
    expect(test.handleKey).toHaveBeenCalledExactlyOnceWith(test.cm, "<C-o>");
    expect(test.dispatch({ key: "i" }).event.defaultPrevented).toBe(true);
    expect(test.handleKey).toHaveBeenLastCalledWith(test.cm, "<C-i>");
    test.scope.dispose();
    expect(test.documentView.scope).toBe(test.parent);
  });

  it("preserves insert, visual, IME, unfocused, suggestion and suspended input", () => {
    const test = setup();
    test.cm.state.vim!.insertMode = true;
    test.dispatch();
    test.cm.state.vim!.insertMode = false;
    test.cm.state.vim!.visualMode = true;
    test.dispatch();
    test.cm.state.vim!.visualMode = false;
    test.dispatch({ isComposing: true });
    test.dispatch({ altKey: true });
    test.dispatch({ key: "f" });
    test.documentView.editMode.editorSuggest.isShowingSuggestion = () => true;
    test.dispatch();
    test.documentView.editMode.editorSuggest.isShowingSuggestion = () => false;
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    test.dispatch();
    input.remove();
    test.view.focus();
    test.suspend();
    test.dispatch();
    expect(test.handleKey).not.toHaveBeenCalled();
    test.scope.refresh();
    expect(test.documentView.scope).toBe(test.parent);
  });

  it("unregisters only owned handlers when another plugin replaces the scope", () => {
    const test = setup();
    const owned = test.documentView.scope;
    const foreign = { handlers: [] };
    test.documentView.scope = foreign;
    test.scope.dispose();
    expect(test.documentView.scope).toBe(foreign);
    expect(owned.handlers).toHaveLength(0);
  });
});
