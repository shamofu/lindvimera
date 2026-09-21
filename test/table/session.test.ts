import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { history, undoDepth } from "@codemirror/commands";
import { editorSession, lindvimeraEditor } from "../../src/runtime/editor";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { encodeCell } from "../../src/table/source";
import { NativeHostFixture } from "./host-fixture";

const source = "| A | B |\n| --- | --- |\n| one two | three |\n| four | five |";
const hosts: NativeHostFixture[] = [];
const bodies: EditorView[] = [];
function host(text = source, prefix = "", suffix = "") {
  const fixture = new NativeHostFixture(text, prefix, suffix);
  hosts.push(fixture);
  return fixture;
}
function body(text: string) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        EditorState.allowMultipleSelections.of(true),
        lindvimeraEditor({
          settings: () => ({ ...DEFAULT_SETTINGS, japanese: false }),
          owner: () => undefined,
        }),
      ],
    }),
  });
  bodies.push(view);
  const cm = getCM(view)!;
  return {
    view,
    cm,
    keys(value: string) {
      for (const key of value.match(/<[^>]+>|./gu) ?? [])
        cm.operation(() => Vim.handleKey(cm, key, "user"));
    },
  };
}

describe("cell-local editing through the production Vim runtime", () => {
  beforeAll(() => {
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  });
  beforeEach(() => Vim.resetVimGlobalState_());
  afterEach(() => {
    for (const fixture of hosts.splice(0)) fixture.destroy();
    for (const view of bodies.splice(0)) view.destroy();
    document.body.replaceChildren();
  });

  it.each([
    ["dd", ""],
    ["2dd", ""],
    ["cc", "changed"],
    ["o", "added"],
    ["O", "added"],
    ["yyP", ""],
    ["yyp", ""],
    ["viwd", ""],
    ["Vd", ""],
    ["<C-v>2Gld", ""],
    ["<C-v>2Glyp", ""],
    ["Gdgg", ""],
    ["dG", ""],
    ["J", ""],
    ["ysiw)", ""],
  ])(
    "%s matches the same multiline body edit without changing other cells",
    (command, inserted) => {
      const text = "one two\nthree four\nfive six";
      const plain = body(text);
      plain.keys(command);
      if (inserted)
        plain.cm.operation(() =>
          plain.view.dispatch(plain.view.state.replaceSelection(inserted), {
            annotations: Transaction.userEvent.of("input.type"),
          }),
        );
      plain.keys("<Esc>");
      const expected = plain.cm.getValue();
      const fixture = host(
        `| A | B |\n| --- | --- |\n| ${encodeCell(text)} | untouched |\n| next | keep |`,
      );
      fixture.keys(command);
      if (inserted) fixture.insert(inserted);
      fixture.keys("<Esc>");
      expect(fixture.engine.getValue()).toBe(expected);
      expect(fixture.values().map((row) => row[1])).toEqual(["B", "untouched", "keep"]);
      expect(fixture.values()[0]).toEqual(["A", "B"]);
      expect(fixture.values()[2]).toEqual(["next", "keep"]);
      expect(fixture.table.rows).toHaveLength(3);
      expect(fixture.table.rows.every((row) => row.length === 2)).toBe(true);
    },
  );

  it("keeps motions, searches and their operators within the current cell", () => {
    const fixture = host("| A | B |\n| --- | --- |\n| one<br>two one | one |\n| one | keep |");
    fixture.keys("99h99kgg");
    expect(fixture.engine.getCursor()).toMatchObject({ line: 0, ch: 0 });
    fixture.keys("*");
    expect(fixture.engine.getCursor()).toMatchObject({ line: 1, ch: 4 });
    fixture.keys("n");
    expect(fixture.engine.getCursor()).toMatchObject({ line: 0, ch: 0 });
    fixture.keys("G$");
    expect(fixture.engine.getCursor()).toMatchObject({ line: 1, ch: 6 });
    fixture.keys("99j99l99w");
    expect(fixture.tableCell!.cell).toMatchObject({ row: 1, col: 0 });
    fixture.keys("ggdG");
    expect(fixture.engine.getValue()).toBe("");
    expect(fixture.values()).toEqual([
      ["A", "B"],
      ["", "one"],
      ["one", "keep"],
    ]);
  });

  it("uses decoded pipe and line-break coordinates for find and delete", () => {
    const fixture = host("| A | B |\n| --- | --- |\n| a\\|b\\|c<br>next | keep |");
    fixture.keys("f|;");
    expect(fixture.engine.getCursor()).toMatchObject({ line: 0, ch: 3 });
    fixture.keys(",0df|");
    expect(fixture.values()[1]).toEqual(["b|c\nnext", "keep"]);
  });

  it("shares undo and redo while dd deletes one cell line", () => {
    const fixture = host();
    fixture.keys("dd");
    expect(fixture.values()).toEqual([
      ["A", "B"],
      ["", "three"],
      ["four", "five"],
    ]);
    expect(undoDepth(fixture.cm.state)).toBe(1);
    fixture.keys("u");
    expect(fixture.cm.state.doc.toString()).toBe(source);
    fixture.keys("<C-r>");
    expect(fixture.values()[1]).toEqual(["", "three"]);
  });

  it("records a change and its Insert tail once, retaining dot after native recreation", () => {
    const fixture = host();
    fixture.keys("ciw");
    fixture.insert("日本語");
    fixture.keys("<Esc>");
    expect(Vim.getRegisterController().getRegister(".").toString()).toBe("日本語");
    expect(fixture.values()[1]).toEqual(["日本語 two", "three"]);
    expect(undoDepth(fixture.cm.state)).toBe(1);
    fixture.regenerate();
    fixture.focus({ row: 1, column: 1, offset: 0 });
    fixture.keys(".");
    expect(fixture.values()[1]).toEqual(["日本語 two", "日本語"]);
    fixture.keys("u");
    expect(fixture.values()[1]).toEqual(["日本語 two", "three"]);
    fixture.keys("u");
    expect(fixture.cm.state.doc.toString()).toBe(source);
  });

  it("keeps a change in one undo group when the host rebuilds its current Insert cell", () => {
    const fixture = host();
    fixture.keys("ciw");
    fixture.insert("new");
    fixture.regenerate();
    fixture.insert(" text");
    fixture.keys("<Esc>");
    expect(fixture.values()[1]).toEqual(["new text two", "three"]);
    expect(undoDepth(fixture.cm.state)).toBe(1);
    expect(Vim.getRegisterController().getRegister(".").toString()).toBe("new text");
    fixture.keys("u");
    expect(fixture.cm.state.doc.toString()).toBe(source);
  });

  it.each(["arrow", "pointer"])(
    "splits the shared parent history after a cell Insert %s move",
    (move) => {
      const fixture = host();
      fixture.keys("ciw");
      fixture.insert("abc");
      if (move === "arrow") fixture.dom("<ArrowLeft>");
      else
        fixture.tableCell!.cm.dispatch({
          selection: { anchor: 2 },
          userEvent: "select.pointer",
        });
      fixture.insert("X");
      fixture.keys("<Esc>");
      expect(fixture.values()[1]).toEqual(["abXc two", "three"]);
      expect(undoDepth(fixture.cm.state)).toBe(2);
      fixture.keys("u");
      expect(fixture.values()[1]).toEqual(["abc two", "three"]);
      fixture.keys("u");
      expect(fixture.cm.state.doc.toString()).toBe(source);
      fixture.keys("<C-r>");
      expect(fixture.values()[1]).toEqual(["abc two", "three"]);
      fixture.keys("<C-r>");
      expect(fixture.values()[1]).toEqual(["abXc two", "three"]);
    },
  );

  it("does not split cell Insert history for a no-op arrow or preview rendering", () => {
    const fixture = host();
    fixture.settings.escapeSequences = ["jj"];
    editorSession(fixture.cm)!.configure();
    fixture.keys("ciw");
    fixture.dom("<ArrowLeft>");
    fixture.insert("abc");
    fixture.dom("j");
    expect(fixture.engine.getValue()).toBe("abc two");
    fixture.dom("x<Esc>");
    expect(fixture.values()[1]).toEqual(["abcjx two", "three"]);
    expect(undoDepth(fixture.cm.state)).toBe(1);
    fixture.keys("u");
    expect(fixture.cm.state.doc.toString()).toBe(source);
  });

  it("flushes a pending escape literal into the earlier edit before a cell Insert move", () => {
    const fixture = host();
    fixture.settings.escapeSequences = ["jj"];
    editorSession(fixture.cm)!.configure();
    fixture.keys("ciw");
    fixture.insert("abc");
    fixture.dom("j<ArrowLeft>X<Esc>");
    expect(fixture.values()[1]).toEqual(["abcXj two", "three"]);
    expect(undoDepth(fixture.cm.state)).toBe(2);
    fixture.keys("u");
    expect(fixture.values()[1]).toEqual(["abcj two", "three"]);
    fixture.keys("u");
    expect(fixture.cm.state.doc.toString()).toBe(source);
  });

  it("does not split shared cell history for a composition selection update", () => {
    const fixture = host();
    fixture.keys("ciw");
    fixture.insert("あい");
    const cell = fixture.tableCell!.cm;
    const composing = vi.spyOn(cell, "composing", "get").mockReturnValue(true);
    cell.dispatch({ selection: { anchor: 1, head: 2 }, userEvent: "select" });
    cell.dispatch(cell.state.replaceSelection("う"), { userEvent: "input.type.compose" });
    composing.mockRestore();
    fixture.keys("<Esc>");
    expect(fixture.values()[1]).toEqual(["あう two", "three"]);
    expect(undoDepth(fixture.cm.state)).toBe(1);
    fixture.keys("u");
    expect(fixture.cm.state.doc.toString()).toBe(source);
  });

  it("shares named registers and recorded macros across recreated cell editors", () => {
    const fixture = host();
    const engine = fixture.engine;
    fixture.keys('"ayiwqaddq');
    expect(Vim.getRegisterController().getRegister("a").toString()).not.toBe("");
    fixture.focus({ row: 2, column: 0, offset: 0 });
    fixture.regenerate();
    fixture.keys("@a");
    expect(fixture.values()[1]).toEqual(["", "three"]);
    expect(fixture.values()[2]).toEqual(["", "five"]);
    expect(fixture.engine).toBe(engine);
    expect(getCM(fixture.tableCell!.cm)).toBeNull();
    fixture.focus({ row: 1, column: 1, offset: 0 });
    fixture.keys('"byiw');
    fixture.focus({ row: 2, column: 1, offset: 0 });
    fixture.keys('"bP');
    expect(fixture.values()[2]).toEqual(["", "threefive"]);
  });

  it("Normal DOM Tab navigates cells with clamped endpoints and cancels Visual/operator input", () => {
    const fixture = host();
    fixture.dom("<Tab>");
    expect(fixture.tableCell!.cell).toMatchObject({ row: 1, col: 1 });
    fixture.dom("<S-Tab>");
    expect(fixture.tableCell!.cell).toMatchObject({ row: 1, col: 0 });
    fixture.dom("v<Tab>");
    expect(fixture.engine.state.vim!.visualMode).toBe(false);
    fixture.dom("d<Tab>");
    expect(fixture.tableCell!.cell).toMatchObject({ row: 2, col: 0 });
    expect(fixture.engine.state.vim!.inputState.operator).toBeFalsy();
    fixture.dom("ysiw<Tab>");
    expect(fixture.engine.state.vim!.expectLiteralNext).toBe(false);
    fixture.focus({ row: 2, column: 1, offset: 0 });
    fixture.dom("<Tab>");
    expect(fixture.tableCell!.cell).toMatchObject({ row: 2, col: 1 });
    fixture.focus({ row: 0, column: 0, offset: 0 });
    fixture.dom("<S-Tab>");
    expect(fixture.tableCell!.cell).toMatchObject({ row: 0, col: 0 });
    expect(fixture.cm.state.doc.toString()).toBe(source);
    expect(fixture.nativeKeys).toEqual([]);
  });

  it("Insert DOM Tab, Shift-Tab and Enter run the host cell commands and retain Insert", () => {
    const fixture = host();
    fixture.dom("i<Tab><S-Tab><CR>");
    expect(fixture.nativeKeys).toEqual(["Tab", "Shift-Tab", "Enter"]);
    expect(fixture.tableCell!.cell).toMatchObject({ row: 2, col: 0 });
    expect(fixture.engine.state.vim!.insertMode).toBe(true);
    fixture.focus({ row: 2, column: 1, offset: 0 });
    fixture.dom("<Tab>");
    expect(fixture.values()).toHaveLength(4);
    expect(fixture.tableCell!.cell).toMatchObject({ row: 3, col: 0 });
    expect(fixture.engine.state.vim!.insertMode).toBe(true);
  });

  it("Ctrl+V starts cell-local block selection and Ctrl+C cancels through DOM input", () => {
    const fixture = host();
    fixture.dom("<C-v>l");
    expect(fixture.engine.state.vim!.visualBlock).toBe(true);
    expect(fixture.engine.getSelection()).toBe("on");
    fixture.dom("<C-c>");
    expect(fixture.engine.state.vim!.visualMode).toBe(false);
    fixture.dom("d<C-c>w");
    expect(fixture.engine.state.vim!.inputState.operator).toBeFalsy();
    expect(fixture.cm.state.doc.toString()).toBe(source);
    expect(fixture.engine.getCursor()).toMatchObject({ line: 0, ch: 4 });
  });

  it("Esc stays in the cell and [t/]t leave only when adjacent prose exists", () => {
    const fixture = host(source, "before\n\n", "\n\nafter");
    fixture.dom("i<Esc>");
    expect(fixture.tableCell).not.toBeNull();
    fixture.dom("[t");
    expect(fixture.tableCell).toBeNull();
    expect(fixture.cm.state.selection.main.head).toBe("before\n".length);
    fixture.focus({ row: 1, column: 0, offset: 0 });
    fixture.dom("]t");
    expect(fixture.tableCell).toBeNull();
    expect(fixture.cm.state.selection.main.head).toBe(fixture.table.end + 1);
    const atEdges = host();
    atEdges.dom("[t]t");
    expect(atEdges.tableCell).not.toBeNull();
  });

  it("flushes an optional jj prefix to the originating cell before native navigation", () => {
    const fixture = host();
    fixture.settings.escapeSequences = ["jj"];
    editorSession(fixture.cm)!.configure();
    fixture.dom("ij");
    expect(fixture.engine.getValue()).toBe("one two");
    fixture.dom("<Tab>");
    expect(fixture.values()[1]).toEqual(["jone two", "three"]);
    expect(fixture.engine.state.vim!.insertMode).toBe(true);
    fixture.dom("jj");
    expect(fixture.engine.state.vim!.insertMode).toBe(false);
    expect(fixture.values()[1]).toEqual(["jone two", "three"]);
  });
});
