import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { NativeNavigationManager } from "../src/engines/builtin/navigation";
import type { NativeAction, NativeCM, NativeVim } from "../src/engines/builtin/native";
import type { BackendHost } from "../src/engines/types";
import { loadSettings } from "../src/settings";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function setup() {
  const view = new EditorView({
    state: EditorState.create({ doc: "alpha\nbeta\ngamma" }),
    parent: document.body,
  });
  const cm = {
    cm6: view,
    state: {
      vim: {
        inputState: { keyBuffer: [], getRepeat: () => 1 },
        sel: { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } },
      },
    },
    getValue: () => view.state.doc.toString(),
    getCursor: () => cm.posFromIndex(view.state.selection.main.head),
    indexFromPos: (position: { line: number; ch: number }) =>
      view.state.doc.line(position.line + 1).from + position.ch,
    posFromIndex: (offset: number) => {
      const line = view.state.doc.lineAt(offset);
      return { line: line.number - 1, ch: offset - line.from };
    },
    setCursor: (position: { line: number; ch: number }) =>
      view.dispatch({ selection: { anchor: cm.indexFromPos(position) } }),
  } as unknown as NativeCM;
  Object.assign(view, { cm });
  const documentView = { file: {}, editMode: { cm: view, tableCell: null } };
  const actions = new Map<string, NativeAction>();
  const errors: string[] = [];
  const jumpList = { add(_cm: NativeCM, _from: object, _to: object) {} };
  const original = jumpList.add;
  const vim = {
    defineAction: (name: string, action: NativeAction) => actions.set(name, action),
    getVimGlobalState_: () => ({ jumpList }),
    handleKey() {},
  } as unknown as NativeVim;
  const host = {
    app: {
      workspace: {
        iterateAllLeaves: (callback: (leaf: object) => void) => callback({ view: documentView }),
      },
    },
    settings: () => loadSettings({ engine: "builtin" }),
    isActive: () => true,
    reportError: (message: string) => errors.push(message),
  } as unknown as BackendHost;
  const navigation = new NativeNavigationManager(host);
  navigation.attach(cm, vim);
  cleanup.push(() => {
    navigation.dispose();
    view.destroy();
  });
  const action = (name: string, args: object = {}) =>
    actions.get(`lindvimera115_navigation_${name}`)!(cm, { repeat: 1, ...args }, cm.state.vim!);
  return { view, cm, documentView, actions, errors, navigation, action, jumpList, original };
}

describe("native logical navigation", () => {
  it("restores exact local marks and keeps native jump recording while owning its observer", async () => {
    const s = setup();
    s.cm.setCursor({ line: 0, ch: 2 });
    s.action("mark", { selectedCharacter: "a" });
    s.cm.setCursor({ line: 2, ch: 1 });
    s.action("go", { selectedCharacter: "a" });
    await s.navigation.settled();
    expect(s.cm.getCursor()).toEqual({ line: 0, ch: 2 });
    s.action("walk", { forward: false });
    await s.navigation.settled();
    expect(s.cm.getCursor()).toEqual({ line: 2, ch: 1 });
    s.navigation.dispose();
    expect(s.jumpList.add).toBe(s.original);
  });

  it("never restores an old document's mark into a reused pane", async () => {
    const s = setup();
    s.action("mark", { selectedCharacter: "a" });
    s.documentView.file = {};
    s.cm.setCursor({ line: 2, ch: 2 });
    s.action("go", { selectedCharacter: "a" });
    await s.navigation.settled();
    expect(s.cm.getCursor()).toEqual({ line: 2, ch: 2 });
    expect(s.errors.join(" ")).toContain("存在しません");
  });
});
