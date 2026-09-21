import { beforeAll, afterEach, beforeEach, it, expect, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { vim, vimTarget, Vim, getCM } from "@replit/codemirror-vim";
import { NativeHostFixture } from "../table/host-fixture";
const hosts: NativeHostFixture[] = [];
const views: EditorView[] = [];
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
beforeEach(() => Vim.resetVimGlobalState_());
afterEach(() => {
  for (const host of hosts.splice(0)) host.destroy();
  for (const view of views.splice(0).reverse()) view.destroy();
  document.body.replaceChildren();
});
function setup(text = "one two\nthree four") {
  const parent = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: "parent untouched",
      extensions: [vim(), history(), EditorState.allowMultipleSelections.of(true)],
    }),
  });
  views.push(parent);
  const cm = getCM(parent)!;
  const cell = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: text, extensions: [vimTarget(() => cm)] }),
  });
  views.push(cell);
  let target = cell;
  cm.editingViewProvider = () => target;
  cm.refreshEditingTarget();
  return {
    parent,
    cell,
    cm,
    keys: (...keys: string[]) => keys.forEach((key) => Vim.handleKey(cm, key, "user")),
    target: (view: EditorView, preserveCoordinates = false) => {
      target = view;
      cm.refreshEditingTarget(preserveCoordinates);
    },
  };
}
it("routes line edits and navigation to a multiline cell", () => {
  const f = setup();
  f.keys("d", "d");
  expect(f.cm.getValue()).toBe("three four");
  expect(f.parent.state.doc.toString()).toBe("parent untouched");
  f.keys("G");
  expect(f.cm.getCursor().line).toBe(0);
});
it("clips G/dG to a native buffer and handles normal line paste", () => {
  const f = setup();
  f.keys("y", "y", "p");
  expect(f.cm.getValue()).toBe("one two\none two\nthree four");
  f.keys("d", "G");
  // Neovim -u NONE: yypdG removes the complete final lines, including their separator.
  expect(f.cm.getValue()).toBe("one two");
});
it("routes character and block selections to native multi ranges", () => {
  const f = setup("abc\ndef");
  f.keys("<C-v>", "j", "l", "d");
  expect(f.cm.getValue()).toBe("c\nf");
  expect(f.parent.state.doc.toString()).toBe("parent untouched");
});
it("records native updates but ignores mirrored parent writes", () => {
  const f = setup("a");
  let text = "";
  f.cm.on("change", (_: unknown, change: { text: string[] }) => {
    text += change.text.join("\n");
  });
  f.cell.dispatch({ changes: { from: 1, insert: "z" } });
  f.parent.dispatch({ changes: { from: 0, insert: "mirrored" } });
  expect(text).toBe("z");
});
it("searches only the current cell", () => {
  const f = setup("one two\nthree four");
  const search = f.cm.getSearchCursor(/parent|four/, { line: 0, ch: 0 });
  expect(search.findNext()?.[0]).toBe("four");
  expect(search.from()).toEqual({ line: 1, ch: 6 });
  expect(search.findNext()).toBeNull();
});
it("retains insertion replay across target switches", () => {
  const f = setup("");
  f.keys("i");
  f.cm.replaceSelection("x");
  f.target(f.parent);
  f.cm.replaceSelection("y");
  f.keys("<Esc>");
  expect(f.cell.state.doc.toString()).toBe("x");
  f.target(f.cell);
  f.keys(".");
  expect(f.cm.getValue()).toBe("xxy");
});
it("keeps bookmarks attached to the target coordinate space", () => {
  const f = setup("abc");
  const mark = f.cm.setBookmark({ line: 0, ch: 2 });
  f.parent.dispatch({ changes: { from: 0, insert: "more" } });
  expect(mark.find()).toEqual({ line: 0, ch: 2 });
  f.target(f.parent);
  expect(mark.find()).toBeNull();
  f.target(f.cell);
  expect(mark.find()).toEqual({ line: 0, ch: 2 });
});

it("replays explicitly recorded native Insert navigation", () => {
  const f = setup("");
  f.cm.nativeInputHandler = (key) => {
    if (key !== "Tab") return false;
    f.target(f.parent);
    return true;
  };
  f.keys("i");
  f.cm.replaceSelection("x");
  Vim.recordNativeInputKey(f.cm, "Tab");
  f.target(f.parent);
  f.cm.replaceSelection("y");
  f.keys("<Esc>");
  f.target(f.cell);
  f.keys(".");
  expect(f.cell.state.doc.toString()).toBe("xx");
  expect(f.parent.state.doc.toString()).toBe("yyparent untouched");
});
it.each([
  ["d", "d"],
  ["G", "d", "G"],
  ["g", "g", "o", "<Esc>"],
  ["y", "y", "p"],
  ["<C-v>", "j", "l", "d"],
])("matches the owner buffer semantics: %s", (...keys) => {
  const f = setup("abc def\nghi jkl\nmno");
  const body = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: f.cell.state.doc.toString(),
      extensions: [vim(), history(), EditorState.allowMultipleSelections.of(true)],
    }),
  });
  views.push(body);
  const bodyCM = getCM(body)!;
  for (const key of keys) Vim.handleKey(bodyCM, key, "user");
  f.keys(...keys);
  expect(f.cm.getValue()).toBe(bodyCM.getValue());
  expect(f.cm.listSelections()).toEqual(bodyCM.listSelections());
});

it("rebinds a bookmark to a regenerated view for the same cell", () => {
  const f = setup("abc");
  const mark = f.cm.setBookmark({ line: 0, ch: 2 });
  const replacement = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: "abc", extensions: [vimTarget(() => f.cm)] }),
  });
  views.push(replacement);
  f.target(replacement, true);
  replacement.dispatch({ changes: { from: 0, insert: "x" } });
  expect(mark.find()).toEqual({ line: 0, ch: 3 });
  expect(f.cm.cm6).toBe(f.parent);
  expect(getCM(replacement)).toBeNull();
});
it("replays native Insert navigation in recorded macros", () => {
  const f = setup("");
  f.cm.nativeInputHandler = (key) => {
    if (key !== "Tab") return false;
    f.target(f.parent);
    return true;
  };
  f.keys("q", "c", "i");
  f.cm.replaceSelection("x");
  Vim.recordNativeInputKey(f.cm, "Tab");
  f.target(f.parent);
  f.cm.replaceSelection("y");
  f.keys("<Esc>", "q");
  f.target(f.cell);
  f.keys("@", "c");
  expect(f.cell.state.doc.toString()).toBe("xx");
  expect(f.parent.state.doc.toString()).toBe("yyparent untouched");
});
it("leaves a host-consumed DOM key untouched", () => {
  const f = setup();
  f.target(f.parent);
  f.parent.contentDOM.addEventListener("keydown", (event) => event.preventDefault(), {
    capture: true,
    once: true,
  });
  f.parent.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }),
  );
  expect(f.parent.state.doc.toString()).toBe("parent untouched");
  expect(f.cm.state.vim?.insertMode).toBe(false);
});

function nativeHost() {
  const host = new NativeHostFixture("| A | B |\n| --- | --- |\n| one two | three four |");
  hosts.push(host);
  return host;
}
it("cancels a pending operator when the host switches cells", () => {
  const host = nativeHost();
  host.keys("d");
  host.focus({ row: 1, column: 1, offset: 0 });
  host.keys("w");
  expect(host.values()[1]).toEqual(["one two", "three four"]);
  expect(host.engine.getCursor()).toEqual({ line: 0, ch: 6 });
});
it("cancels a Visual selection on host focus without moving the new cell cursor", () => {
  const host = nativeHost();
  host.keys("vll");
  host.focus({ row: 1, column: 1, offset: 0 });
  expect(host.engine.state.vim?.visualMode).toBe(false);
  expect(host.engine.getCursor()).toEqual({ line: 0, ch: 0 });
  expect(host.engine.somethingSelected()).toBe(false);
});
it("retains Insert replay when the native host recreates the same cell", () => {
  const host = nativeHost();
  host.keys("i");
  host.insert("X");
  host.regenerate();
  host.insert("Y");
  host.keys("<Esc>");
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("XY");
  host.focus({ row: 1, column: 1, offset: 0 });
  host.keys(".");
  expect(host.values()[1]).toEqual(["XYone two", "XYthree four"]);
});

it("uses DOM Ctrl-C to cancel Visual mode immediately in the owner editor", () => {
  const f = setup();
  f.target(f.parent);
  f.keys("v", "l");
  const event = new KeyboardEvent("keydown", {
    key: "c",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  f.parent.contentDOM.dispatchEvent(event);
  expect(f.cm.state.vim?.visualMode).toBe(false);
  expect(event.defaultPrevented).toBe(true);
});

it("allows an opt-in mapped action to cancel a pending operator, including macro replay", () => {
  const f = setup();
  let calls = 0;
  Vim.defineAction("testTargetAction", () => {
    calls++;
  });
  Vim.mapCommand(
    "<F11>",
    "action",
    "testTargetAction",
    {},
    {
      context: "operatorPending",
      cancelPendingOperator: true,
      when: (cm: unknown) => cm === f.cm,
    },
  );
  f.keys("q", "a", "d", "<F11>", "q");
  expect(calls).toBe(1);
  expect(f.cm.state.vim?.inputState.operator).toBeFalsy();
  f.keys("@", "a");
  expect(calls).toBe(2);
  expect(f.cm.getValue()).toBe("one two\nthree four");
});

it.each([".", "@a"])("records native Shift-Enter as one newline for %s replay", (repeat) => {
  const host = nativeHost();
  host.dom("qaiX<S-CR>Y<Esc>q");
  expect(host.values()[1]).toEqual(["X\nYone two", "three four"]);
  host.focus({ row: 1, column: 1, offset: 0 });
  host.keys(repeat);
  expect(host.values()[1]).toEqual(["X\nYone two", "X\nYthree four"]);
  expect(host.nativeKeys).toEqual([]);
});
it.each([false, true])(
  "rolls back a declined native key without losing text (intervening edit: %s)",
  (intervening) => {
    const f = setup("");
    let replayed = 0;
    f.cm.nativeInputHandler = () => {
      replayed++;
      return false;
    };
    f.keys("i");
    f.cm.replaceSelection("X");
    const rollback = Vim.recordNativeInputKey(f.cm, "Tab");
    if (intervening) f.cm.replaceSelection("Y");
    rollback?.();
    rollback?.();
    if (!intervening) f.cm.replaceSelection("Y");
    f.keys("<Esc>", "0", ".");
    expect(f.cm.getValue()).toBe("XYXY");
    expect(replayed).toBe(0);
  },
);
it("does not replay an Insert Tab that the host declined", () => {
  const host = nativeHost();
  const nativeKey = vi.spyOn(host.session, "nativeKey").mockReturnValue(false);
  host.tableCell!.cm.contentDOM.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Tab") event.stopImmediatePropagation();
    },
    true,
  );
  host.dom("iX<Tab>Y<Esc>");
  expect(host.values()[1]).toEqual(["XYone two", "three four"]);
  expect(nativeKey).toHaveBeenCalledTimes(1);
  host.keys("0.");
  expect(host.values()[1]).toEqual(["XYXYone two", "three four"]);
  expect(nativeKey).toHaveBeenCalledTimes(1);
  nativeKey.mockRestore();
});

it("honors a saved Insert Tab mapping before native cell navigation", () => {
  const host = nativeHost();
  host.settings.keyBindings = [{ mode: "insert", from: "<Tab>", to: "<Esc>" }];
  Vim.map("<Tab>", "<Esc>", "insert");
  try {
    host.dom("i<Tab>");
    expect(host.engine.state.vim?.insertMode).toBe(false);
    expect(host.tableCell!.cell).toMatchObject({ row: 1, col: 0 });
    expect(host.nativeKeys).toEqual([]);
  } finally {
    Vim.unmap("<Tab>", "insert");
  }
});

it("opens Vim search in the current cell and keeps matches cell-local", () => {
  const f = setup("first needle\nlast needle");
  f.keys("/");
  const input = f.cell.dom.querySelector<HTMLInputElement>(".cm-vim-panel input");
  expect(input).not.toBeNull();
  expect(f.parent.dom.querySelector(".cm-vim-panel input")).toBeNull();
  input!.value = "needle";
  input!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }),
  );
  expect(f.cm.getCursor()).toEqual({ line: 0, ch: 6 });
  expect(f.cell.dom.querySelector(".cm-vim-panel input")).toBeNull();
  f.keys("n");
  expect(f.cm.getCursor()).toEqual({ line: 1, ch: 5 });
  expect(f.parent.state.doc.toString()).toBe("parent untouched");
});

it("lets the native search input handle Enter and Escape before editor shortcuts", () => {
  const host = new NativeHostFixture("| A | B |\n| --- | --- |\n| left | a\\|b<br>続き |");
  hosts.push(host);
  host.focus({ row: 1, column: 1, offset: 0 });
  // Keep a real parent widget so selection updates preserve the nested cell and panels.
  const cellDOM = host.tableCell!.cm.dom;
  class CellWidget extends WidgetType {
    toDOM() {
      return cellDOM;
    }
  }
  host.cm.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.decorations.of(
        Decoration.set(Decoration.widget({ widget: new CellWidget(), block: true }).range(0)),
      ),
    ),
  });
  host.dom("/");
  let input = host.tableCell!.cm.dom.querySelector<HTMLInputElement>(".cm-vim-panel input");
  expect(input).not.toBeNull();
  const pasteKey = new KeyboardEvent("keydown", {
    key: "v",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  input!.dispatchEvent(pasteKey);
  expect(pasteKey.defaultPrevented).toBe(false);
  expect(host.engine.state.vim?.visualMode).toBe(false);
  input!.value = "続き";
  input!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }),
  );
  expect(host.engine.getCursor()).toEqual({ line: 1, ch: 0 });
  expect(host.engine.state.dialog).toBeNull();
  expect(host.tableCell!.cm.dom.querySelector(".cm-vim-panel input")).toBeNull();
  host.dom("/");
  input = host.tableCell!.cm.dom.querySelector<HTMLInputElement>(".cm-vim-panel input");
  input!.value = "cancelled";
  input!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true }),
  );
  expect(host.engine.state.dialog).toBeNull();
  expect(host.engine.getCursor()).toEqual({ line: 1, ch: 0 });
});
