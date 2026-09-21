import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState, StateEffect, Transaction } from "@codemirror/state";
import { indentService } from "@codemirror/language";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, redo, undo, undoDepth } from "@codemirror/commands";
import { getCM, Vim } from "@replit/codemirror-vim";
import { editorSession, lindvimeraEditor } from "../../src/runtime/editor";
import { DEFAULT_SETTINGS, type LindvimeraSettings } from "../../src/settings";
import { encodeCell } from "../../src/table/source";
import { NativeHostFixture } from "../table/host-fixture";
import { SUPPORTED_COMMANDS, SUPPORTED_EXTENSION_KEYS } from "../../src/input/policy";

const cleanup: (() => void)[] = [];

beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
beforeEach(() => Vim.resetVimGlobalState_());
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  document.body.replaceChildren();
});

/** A real keydown followed by the native insertion jsdom cannot perform itself. */
function press(view: EditorView, sequence: string): void {
  const names: Record<string, string> = {
    Esc: "Escape",
    CR: "Enter",
    BS: "Backspace",
    Del: "Delete",
    Left: "ArrowLeft",
    Right: "ArrowRight",
    Up: "ArrowUp",
    Down: "ArrowDown",
    Space: " ",
  };
  for (const token of sequence.match(/<[^>]+>|./gu) ?? []) {
    const special = token.startsWith("<") && token.endsWith(">");
    const parts = special ? token.slice(1, -1).split("-") : [token];
    const value = parts.at(-1)!;
    const event = new KeyboardEvent("keydown", {
      key: names[value] ?? value,
      ctrlKey: special && parts.includes("C"),
      shiftKey: special && parts.includes("S"),
      altKey: special && parts.includes("A"),
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);
    if (!event.defaultPrevented && !special) {
      const input = new InputEvent("beforeinput", {
        inputType: "insertText",
        data: token,
        bubbles: true,
        cancelable: true,
      });
      view.contentDOM.dispatchEvent(input);
      if (!input.defaultPrevented)
        view.dispatch(view.state.replaceSelection(token), {
          annotations: Transaction.userEvent.of("input.type"),
        });
    }
  }
}

function create(target: "body" | "cell", text: string, at = 0) {
  const nativeEscape = vi.fn(() => true);
  let settings: LindvimeraSettings = { ...DEFAULT_SETTINGS, japanese: false };
  let view: EditorView;
  let parent: EditorView;
  let fixture: NativeHostFixture | undefined;
  if (target === "cell") {
    fixture = new NativeHostFixture(
      `| A | B |\n| --- | --- |\n| ${encodeCell(text)} | untouched |\n| next | keep |`,
    );
    parent = fixture.cm;
    view = fixture.tableCell!.cm;
    settings = fixture.settings;
    cleanup.push(() => fixture!.destroy());
  } else {
    parent = view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          EditorState.allowMultipleSelections.of(true),
          // A host handler ahead of the Vim extension reproduces Obsidian's conflict.
          keymap.of([{ key: "Escape", run: nativeEscape }]),
          lindvimeraEditor({
            settings: () => settings,
            owner: () => undefined,
          }),
          keymap.of(defaultKeymap),
        ],
      }),
    });
    cleanup.push(() => view.destroy());
  }
  view.focus();
  const cm = getCM(parent)!;
  cm.setCursor(cm.posFromIndex(at));
  return {
    cm,
    parent,
    view,
    nativeEscape,
    settings,
    keys(sequence: string) {
      press(view, sequence);
    },
    unchangedNeighbours() {
      if (!fixture) return;
      expect(fixture.values().map((row) => row[1])).toEqual(["B", "untouched", "keep"]);
      expect(fixture.values()[0]).toEqual(["A", "B"]);
      expect(fixture.values()[2]).toEqual(["next", "keep"]);
      expect(fixture.table.rows).toHaveLength(3);
    },
  };
}

interface MotionCase {
  key: string;
  text: string;
  at: number;
  end: number;
}
const motions: MotionCase[] = [
  { key: "h", text: "abc", at: 1, end: 0 },
  { key: "l", text: "abc", at: 0, end: 1 },
  { key: "j", text: "abc\ndef", at: 1, end: 5 },
  { key: "k", text: "abc\ndef", at: 5, end: 1 },
  { key: "<Left>", text: "abc", at: 1, end: 0 },
  { key: "<Right>", text: "abc", at: 0, end: 1 },
  { key: "<Down>", text: "abc\ndef", at: 1, end: 5 },
  { key: "<Up>", text: "abc\ndef", at: 5, end: 1 },
  { key: "<BS>", text: "abc", at: 1, end: 0 },
  { key: "<CR>", text: "abc\n  def", at: 1, end: 6 },
  { key: "w", text: "one two", at: 0, end: 4 },
  { key: "b", text: "one two", at: 4, end: 0 },
  { key: "e", text: "one two", at: 0, end: 2 },
  { key: "ge", text: "one two", at: 4, end: 2 },
  { key: "W", text: "one.two next", at: 0, end: 8 },
  { key: "B", text: "one.two next", at: 8, end: 0 },
  { key: "E", text: "one.two next", at: 0, end: 6 },
  { key: "gE", text: "one.two next", at: 8, end: 6 },
  { key: "0", text: "x\n  abc", at: 6, end: 2 },
  { key: "^", text: "x\n  abc", at: 6, end: 4 },
  { key: "$", text: "x\n  abc", at: 2, end: 6 },
  { key: "<Home>", text: "x\n  abc", at: 6, end: 2 },
  { key: "<End>", text: "x\n  abc", at: 2, end: 6 },
  { key: "gg", text: "abc\ndef\nghi", at: 9, end: 0 },
  { key: "G", text: "abc\ndef\nghi", at: 0, end: 8 },
  { key: "2gg", text: "abc\ndef\nghi", at: 0, end: 4 },
  { key: "2G", text: "abc\ndef\nghi", at: 0, end: 4 },
  { key: "fx", text: "a x b x c", at: 0, end: 2 },
  { key: "Fx", text: "a x b x c", at: 8, end: 6 },
  { key: "tx", text: "a x b x c", at: 0, end: 1 },
  { key: "Tx", text: "a x b x c", at: 8, end: 7 },
  { key: "fx;", text: "a x b x c", at: 0, end: 6 },
  { key: "fx;,", text: "a x b x c", at: 0, end: 2 },
  { key: "%", text: "(abc)", at: 0, end: 4 },
  { key: "2w", text: "one two three", at: 0, end: 8 },
  { key: "99h", text: "abc", at: 1, end: 0 },
  { key: "99l", text: "abc", at: 1, end: 2 },
  { key: "99k", text: "abc\ndef", at: 5, end: 1 },
  { key: "99j", text: "abc\ndef", at: 1, end: 5 },
  { key: "*", text: "one two one", at: 0, end: 8 },
  { key: "#", text: "one two one", at: 8, end: 0 },
  { key: "*n", text: "one two one", at: 0, end: 0 },
  { key: "*N", text: "one two one", at: 0, end: 0 },
  { key: "]h", text: "# one\ntext\n# two", at: 2, end: 13 },
  { key: "[h", text: "# one\ntext\n# two", at: 13, end: 2 },
  { key: "]l", text: "- one\n- two", at: 2, end: 8 },
  { key: "[l", text: "- one\n- two", at: 8, end: 2 },
];

interface EditCase {
  key: string;
  text: string;
  result: string;
  at?: number;
  register?: string;
  registerName?: string;
  history?: boolean;
}
const edits: EditCase[] = [
  { key: "iX<Esc>", text: "abc", result: "Xabc" },
  { key: "IX<Esc>", text: "x\n  abc", at: 6, result: "x\n  Xabc" },
  { key: "aX<Esc>", text: "abc", result: "aXbc" },
  { key: "AX<Esc>", text: "abc", result: "abcX" },
  { key: "oX<Esc>", text: "abc", result: "abc\nX" },
  { key: "OX<Esc>", text: "abc", result: "X\nabc" },
  { key: "rX", text: "abc", result: "Xbc" },
  { key: "RXY<Esc>", text: "abcd", result: "XYcd" },
  { key: "x", text: "abc", result: "bc", register: "a" },
  { key: "X", text: "abc", at: 1, result: "bc", register: "a" },
  { key: "<Del>", text: "abc", result: "bc", register: "a" },
  { key: "dw", text: "one two", result: "two", register: "one " },
  { key: "2d2w", text: "one two three four five", result: "five" },
  { key: "dd", text: "one\ntwo", result: "two", register: "one\n" },
  { key: "D", text: "one two\nlast", at: 4, result: "one \nlast", register: "two" },
  { key: "cwX<Esc>", text: "one two", result: "X two", register: "one" },
  { key: "ccX<Esc>", text: "one\ntwo", result: "X\ntwo" },
  { key: "CX<Esc>", text: "one two", at: 4, result: "one X" },
  { key: "sX<Esc>", text: "abc", result: "Xbc" },
  { key: "SX<Esc>", text: "one\ntwo", result: "X\ntwo" },
  { key: "yw", text: "one two", result: "one two", register: "one ", history: false },
  { key: "yy", text: "one\ntwo", result: "one\ntwo", register: "one\n", history: false },
  { key: "Y", text: "one\ntwo", result: "one\ntwo", register: "one\n", history: false },
  {
    key: '"ayw',
    text: "one two",
    result: "one two",
    register: "one ",
    registerName: "a",
    history: false,
  },
  { key: "yyp", text: "one\ntwo", result: "one\none\ntwo" },
  { key: "yyP", text: "one\ntwo", result: "one\none\ntwo" },
  { key: "xp", text: "abc", result: "bac" },
  { key: "xP", text: "abc", result: "abc" },
  { key: "J", text: "one\ntwo", result: "one two" },
  { key: ">>", text: "pre\none\npost", at: 4, result: "pre\n  one\npost" },
  { key: "<<", text: "pre\n  one\npost", at: 6, result: "pre\none\npost" },
  { key: "==", text: "pre\n  one\npost", at: 6, result: "pre\none\npost" },
  { key: "diw", text: "pre\none two\npost", at: 4, result: "pre\n two\npost", register: "one" },
  { key: "daw", text: "one two", result: "two", register: "one " },
  {
    key: "diW",
    text: "pre\none.two next\npost",
    at: 4,
    result: "pre\n next\npost",
    register: "one.two",
  },
  { key: "daW", text: "one.two next", result: "next", register: "one.two " },
  { key: 'di"', text: '"one"', at: 2, result: '""', register: "one" },
  { key: 'da"', text: '"one"', at: 2, result: "", register: '"one"' },
  { key: "di'", text: "'one'", at: 2, result: "''", register: "one" },
  { key: "da'", text: "'one'", at: 2, result: "", register: "'one'" },
  { key: "di`", text: "`one`", at: 2, result: "``", register: "one" },
  { key: "da`", text: "`one`", at: 2, result: "", register: "`one`" },
  ...(
    [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ] as const
  ).flatMap(([left, right]) => [
    {
      key: `di${left}`,
      text: `${left}one${right}`,
      at: 2,
      result: `${left}${right}`,
      register: "one",
    },
    {
      key: `da${left}`,
      text: `${left}one${right}`,
      at: 2,
      result: "",
      register: `${left}one${right}`,
    },
    {
      key: `di${right}`,
      text: `${left}one${right}`,
      at: 2,
      result: `${left}${right}`,
      register: "one",
    },
    {
      key: `da${right}`,
      text: `${left}one${right}`,
      at: 2,
      result: "",
      register: `${left}one${right}`,
    },
  ]),
  { key: "di*", text: "**one**", at: 3, result: "****", register: "one" },
  { key: "da*", text: "**one**", at: 3, result: "", register: "**one**" },
  { key: "di_", text: "_one_", at: 2, result: "__", register: "one" },
  { key: "da_", text: "_one_", at: 2, result: "", register: "_one_" },
  { key: "dil", text: "[[one]]", at: 3, result: "[[]]", register: "one" },
  { key: "dal", text: "[[one]]", at: 3, result: "", register: "[[one]]" },
  { key: "diC", text: "~~~ts\none\n~~~", at: 7, result: "~~~ts\n\n~~~" },
  { key: "daC", text: "~~~ts\none\n~~~", at: 7, result: "" },
  { key: "viwd", text: "pre\none two\npost", at: 4, result: "pre\n two\npost", register: "one" },
  { key: "Vd", text: "one\ntwo", result: "two", register: "one\n" },
  { key: "<C-v>jld", text: "abcd\nefgh", result: "cd\ngh" },
  { key: "viw<Esc>gvd", text: "pre\none two\npost", at: 4, result: "pre\n two\npost" },
  { key: "ysiw)", text: "one two", result: "(one) two" },
  { key: "ysiw(", text: "one two", result: "( one ) two" },
  { key: "yss'", text: "one two", result: "'one two'" },
  { key: "ds'", text: "'one'", at: 2, result: "one" },
  { key: "cs')", text: "'one'", at: 2, result: "(one)" },
  { key: "viwgS)", text: "one two", result: "(one) two" },
  { key: "ysiw*", text: "one two", result: "*one* two" },
  { key: "x.", text: "abcd", result: "cd" },
  { key: "qaxq@a", text: "abcd", result: "cd" },
];

// Each catalogue entry must retain a concrete scenario. Adding a supported key
// requires adding its behavior test, including screen cases in the required E2E suite.
it("accounts for every supported command and extension in executable coverage", () => {
  const evidence = new Set(motions.map(({ key }) => key));
  const motionCases = new Set(motions.map(({ key }) => key));
  const editCases = new Set(edits.map(({ key }) => key));
  const motionAliases: Record<string, string> = {
    "f<character>": "fx",
    "F<character>": "Fx",
    "t<character>": "tx",
    "T<character>": "Tx",
    ";": "fx;",
    ",": "fx;,",
    n: "*n",
    N: "*N",
  };
  for (const [command, scenario] of Object.entries(motionAliases)) {
    expect(motionCases.has(scenario), `${command}: missing motion ${scenario}`).toBe(true);
    evidence.add(command);
  }
  const editAliases: Record<string, string> = {
    i: "iX<Esc>",
    I: "IX<Esc>",
    a: "aX<Esc>",
    A: "AX<Esc>",
    o: "oX<Esc>",
    O: "OX<Esc>",
    "r<character>": "rX",
    R: "RXY<Esc>",
    d: "dw",
    c: "cwX<Esc>",
    y: "yw",
    x: "x",
    X: "X",
    D: "D",
    C: "CX<Esc>",
    s: "sX<Esc>",
    S: "SX<Esc>",
    Y: "Y",
    p: "xp",
    P: "xP",
    J: "J",
    ">": ">>",
    "<": "<<",
    "=": "==",
    "<Del>": "<Del>",
    '"<register>': '"ayw',
    "i<register>": "diw",
    "a<register>": "daw",
    v: "viwd",
    V: "Vd",
    "<C-v>": "<C-v>jld",
    gv: "viw<Esc>gvd",
    ".": "x.",
    "q<register>": "qaxq@a",
    "@<register>": "qaxq@a",
    "i*": "di*",
    "a*": "da*",
    i_: "di_",
    a_: "da_",
    "i`": "di`",
    "a`": "da`",
    il: "dil",
    al: "dal",
    iC: "diC",
    aC: "daC",
    ys: "ysiw)",
    ds: "ds'",
    cs: "cs')",
    gS: "viwgS)",
  };
  for (const [command, scenario] of Object.entries(editAliases)) {
    expect(editCases.has(scenario), `${command}: missing edit ${scenario}`).toBe(true);
    evidence.add(command);
  }
  const localSource = readFileSync(new URL(import.meta.url), "utf8");
  for (const [commands, scenario] of [
    [["<Esc>", "<C-[>", "u", "<C-r>"], "clean defaults cancel Insert once with %s"],
    [["<C-c>"], "cancels an operator with %s"],
    [["/", "?"], "searches from the %s input and restores the editor"],
  ] as const) {
    expect(localSource).toContain(`)("${scenario}"`);
    for (const command of commands) evidence.add(command);
  }
  const external = [
    {
      commands: [
        "gj",
        "gk",
        "g<Up>",
        "g<Down>",
        "<C-f>",
        "<C-b>",
        "<C-d>",
        "<C-u>",
        "H",
        "M",
        "L",
        "<PageUp>",
        "<PageDown>",
        "zz",
        "zt",
        "zb",
      ],
      file: "../../scripts/probe/keyboard-regression.mjs",
      scenario: 'await check("host-keyboard-screen-motions"',
    },
    {
      commands: ["gf"],
      file: "../markdown/engine.test.ts",
      scenario: '"gf"',
    },
    {
      commands: ["<Tab>", "<S-Tab>"],
      file: "../table/session.test.ts",
      scenario:
        'it("Normal DOM Tab navigates cells with clamped endpoints and cancels Visual/operator input"',
    },
    {
      commands: ["[t", "]t"],
      file: "../table/session.test.ts",
      scenario: 'it("Esc stays in the cell and [t/]t leave only when adjacent prose exists"',
    },
  ];
  for (const { commands, file, scenario } of external) {
    expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).toContain(scenario);
    for (const command of commands) evidence.add(command);
  }
  const catalogue = new Set([
    ...SUPPORTED_COMMANDS.map(({ keys }) => keys),
    ...SUPPORTED_EXTENSION_KEYS,
  ]);
  expect([...catalogue].filter((command) => !evidence.has(command))).toEqual([]);
});

describe.each(["body", "cell"] as const)("supported DOM operations in %s", (target) => {
  it.each(motions)("motion $key", ({ key, text, at, end }) => {
    const editor = create(target, text, at);
    editor.keys(key);
    expect(editor.cm.getValue()).toBe(text);
    expect(editor.cm.indexFromPos(editor.cm.getCursor())).toBe(end);
    expect(editor.cm.state.vim?.insertMode).toBe(false);
    expect(editor.cm.state.vim?.visualMode).toBe(false);
    expect(undoDepth(editor.parent.state)).toBe(0);
    editor.unchangedNeighbours();
  });

  it.each(motions.filter(({ key }) => !["<CR>", "*", "#", "*n", "*N"].includes(key)))(
    "Visual motion $key",
    ({ key, text, at, end }) => {
      const editor = create(target, text, at);
      editor.keys(`v${key}`);
      expect(editor.cm.getValue()).toBe(text);
      expect(editor.cm.getSelection()).toBe(text.slice(Math.min(at, end), Math.max(at, end) + 1));
      expect(editor.cm.state.vim?.visualMode).toBe(true);
      expect(undoDepth(editor.parent.state)).toBe(0);
      editor.keys("<Esc>");
      editor.unchangedNeighbours();
    },
  );

  it.each(edits)(
    "edit $key",
    ({ key, text, at, result, register, registerName, history: changed }) => {
      const editor = create(target, text, at);
      if (key === "==")
        editor.view.dispatch({ effects: StateEffect.appendConfig.of(indentService.of(() => 0)) });
      editor.keys(key);
      expect(editor.cm.getValue()).toBe(result);
      expect(editor.cm.state.vim?.insertMode).toBe(false);
      expect(editor.cm.state.vim?.visualMode).toBe(false);
      expect(editor.nativeEscape).not.toHaveBeenCalled();
      if (register !== undefined)
        expect(Vim.getRegisterController().getRegister(registerName).toString()).toBe(register);
      editor.unchangedNeighbours();
      if (changed === false) {
        expect(undoDepth(editor.parent.state)).toBe(0);
      } else {
        expect(undoDepth(editor.parent.state)).toBeGreaterThan(0);
        while (undo(editor.parent)) {
          /* Restore every completed edit in compound commands. */
        }
        expect(editor.cm.getValue()).toBe(text);
        while (redo(editor.parent)) {
          /* Redo must preserve the final text and cell boundaries. */
        }
        expect(editor.cm.getValue()).toBe(result);
        editor.unchangedNeighbours();
      }
    },
  );

  it.each(["<Esc>", "<C-[>"])("clean defaults cancel Insert once with %s", (cancel) => {
    const editor = create(target, "");
    editor.keys(`iabcjj${cancel}`);
    expect(editor.cm.getValue()).toBe("abcjj");
    expect(editor.cm.state.vim?.insertMode).toBe(false);
    expect(Vim.getRegisterController().getRegister(".").toString()).toBe("abcjj");
    expect(editor.nativeEscape).not.toHaveBeenCalled();
    editor.keys("u");
    expect(editor.cm.getValue()).toBe("");
    editor.keys("<C-r>");
    expect(editor.cm.getValue()).toBe("abcjj");
    editor.unchangedNeighbours();
  });

  it.each(["v", "V", "<C-v>"])("selects, swaps ends and cancels %s", (selection) => {
    const editor = create(target, "one two\nthree four");
    editor.keys(`${selection}l`);
    expect(editor.cm.state.vim?.visualMode).toBe(true);
    const selected = editor.cm.getSelection();
    expect(selected).not.toBe("");
    editor.keys("o");
    expect(editor.cm.getSelection()).toBe(selected);
    editor.keys("O");
    expect(editor.cm.getSelection()).toBe(selected);
    editor.keys("<Esc>");
    expect(editor.cm.state.vim?.visualMode).toBe(false);
    expect(editor.cm.getValue()).toBe("one two\nthree four");
    editor.unchangedNeighbours();
  });

  it.each(["<Esc>", "<C-[>", "<C-c>"])("cancels an operator with %s", (cancel) => {
    const editor = create(target, "one two");
    editor.keys(`2d${cancel}w`);
    expect(editor.cm.getValue()).toBe("one two");
    expect(editor.cm.getCursor()).toMatchObject({ line: 0, ch: 4 });
    expect(editor.nativeEscape).not.toHaveBeenCalled();
    expect(undoDepth(editor.parent.state)).toBe(0);
  });

  it("applies each mapping in its own mode through DOM input", () => {
    const editor = create(target, "one two", 4);
    editor.settings.keyBindings = [
      { mode: "normal", from: "H", to: "0" },
      { mode: "visual", from: "L", to: "$" },
      { mode: "operatorPending", from: "H", to: "0" },
      { mode: "insert", from: "<C-l>", to: "<Esc>" },
    ];
    for (const binding of editor.settings.keyBindings)
      Vim.map(binding.from, binding.to, binding.mode);
    try {
      editorSession(editor.parent)!.configure();
      editor.keys("H");
      expect(editor.cm.getCursor()).toMatchObject({ line: 0, ch: 0 });
      editor.keys("vL");
      expect(editor.cm.getSelection()).toBe("one two");
      editor.keys("<Esc>0wyH");
      expect(Vim.getRegisterController().getRegister().toString()).toBe("one ");
      editor.keys("iX<C-l>");
      expect(editor.cm.state.vim?.insertMode).toBe(false);
      expect(editor.cm.getValue()).toBe("one Xtwo");
      editor.unchangedNeighbours();
    } finally {
      for (const binding of editor.settings.keyBindings) Vim.unmap(binding.from, binding.mode);
    }
  });

  it("retains Visual selection while reconfiguring the session", () => {
    const editor = create(target, "one two");
    const session = editorSession(editor.parent)!;
    expect(session.cm).toBe(editor.cm);
    editor.keys("viw");
    expect(editor.cm.getSelection()).toBe("one");
    session.configure();
    expect(editorSession(editor.parent)!.cm).toBe(editor.cm);
    expect(editor.cm.state.vim?.visualMode).toBe(true);
    editor.keys("<Esc>");
  });

  it.each(["/", "?"])("searches from the %s input and restores the editor", (direction) => {
    const editor = create(target, "one two one", direction === "/" ? 0 : 8);
    editor.keys(direction);
    const input = editor.view.dom.querySelector<HTMLInputElement>(".cm-vim-panel input");
    expect(input).not.toBeNull();
    input!.value = "one";
    input!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(editor.cm.state.dialog).toBeNull();
    expect(editor.cm.getCursor()).toMatchObject({ line: 0, ch: direction === "/" ? 8 : 0 });
    expect(editor.cm.getValue()).toBe("one two one");
    editor.unchangedNeighbours();
  });
});
