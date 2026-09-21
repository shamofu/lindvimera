import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, redo, undoDepth } from "@codemirror/commands";
import { getCM, Vim } from "@replit/codemirror-vim";
import type { CodeMirrorV } from "@replit/codemirror-vim-core";
import { editorSession, lindvimeraEditor } from "../../src/runtime/editor";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { NativeHostFixture } from "../table/host-fixture";
import { encodeCell } from "../../src/table/source";

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

function create(text: string, target: "body" | "cell" = "body", documentIdentity?: () => unknown) {
  const errors: string[] = [];
  let parent: EditorView;
  let fixture: NativeHostFixture | undefined;
  if (target === "cell") {
    fixture = new NativeHostFixture(
      `| A | B |\n| --- | --- |\n| ${encodeCell(text)} | untouched |\n| next | keep |`,
    );
    fixture.onError = (message) => errors.push(message);
    parent = fixture.cm;
    cleanup.push(() => fixture!.destroy());
  } else {
    parent = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          lindvimeraEditor({
            settings: () => DEFAULT_SETTINGS,
            owner: () => undefined,
            documentIdentity,
            error: (message) => errors.push(message),
          }),
        ],
      }),
    });
    cleanup.push(() => parent.destroy());
  }
  const cm = getCM(parent)!;
  return {
    cm,
    parent,
    errors,
    fixture,
    ex(input: string) {
      Vim.handleEx(cm as CodeMirrorV, input);
    },
    keys(input: string) {
      for (const key of input.match(/<[^>]+>|./gu) ?? [])
        cm.operation(() => Vim.handleKey(cm, key, "user"));
    },
    confirm(key: string, ctrlKey = false) {
      const input = cm.state.dialog?.querySelector("[data-lindvimera-ex-confirm] input");
      expect(input).toBeTruthy();
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }),
      );
    },
    async settled() {
      await Promise.resolve();
      await Promise.resolve();
    },
    intact() {
      if (fixture) {
        expect(fixture.values().map((row) => row[1])).toEqual(["B", "untouched", "keep"]);
        expect(fixture.values()[2][0]).toBe("next");
      }
    },
  };
}

describe.each(["body", "cell"] as const)("Ex editing in %s", (target) => {
  it("uses explicit first/last ranges and one Undo for multi-line edits", () => {
    const f = create("three\none\ntwo", target);
    f.ex("1sort");
    expect(f.cm.getValue()).toBe("three\none\ntwo");
    f.ex("%sort");
    expect(f.cm.getValue()).toBe("one\nthree\ntwo");
    expect(undoDepth(f.parent.state)).toBe(1);
    undo(f.parent);
    expect(f.cm.getValue()).toBe("three\none\ntwo");
    redo(f.parent);
    expect(f.cm.getValue()).toBe("one\nthree\ntwo");
    f.ex("$d a");
    expect(f.cm.getValue()).toBe("one\nthree");
    expect(Vim.getRegisterController().getRegister("a").toString()).toBe("two\n");
    f.intact();
  });

  it("yanks and puts named registers as lines, including characterwise registers", () => {
    const f = create("one\ntwo\nthree", target);
    f.ex("1,2y a");
    expect(Vim.getRegisterController().getRegister("a").toString()).toBe("one\ntwo\n");
    Vim.getRegisterController().getRegister("b").setText("inserted", false);
    f.ex("1put b");
    expect(f.cm.getValue()).toBe("one\ninserted\ntwo\nthree");
    f.ex("$put a");
    expect(f.cm.getValue()).toBe("one\ninserted\ntwo\nthree\none\ntwo");
    f.intact();
  });

  it("joins the full specified range and sorts reverse numeric/unique/case-insensitive", () => {
    const f = create("one\n  two\nthree\nlast", target);
    f.ex("1,3join");
    expect(f.cm.getValue()).toBe("one two three\nlast");
    f.ex("join");
    expect(f.cm.getValue()).toBe("one two three last");
    const s = create("n2\nn10\nN2\nn1", target);
    s.ex("sort! inu");
    expect(s.cm.getValue()).toBe("n10\nN2\nn1");
    f.intact();
    s.intact();
  });

  it("replaces captures, optional groups, literal dollars and empty replacements", () => {
    const f = create("a ab\na", target);
    f.ex("%s/(a)(b)?/[$1,$2,$&,$$]/gI");
    expect(f.cm.getValue()).toBe("[a,,a,$] [a,b,ab,$]\n[a,,a,$]");
    f.ex("%s/\\[.*?\\]//g");
    expect(f.cm.getValue()).toBe(" \n");
    f.intact();
  });

  it("handles custom delimiters, replacement newlines, zero-width and multiline patterns", () => {
    const f = create("a#b.c\nrest", target);
    f.ex("s#a\\#b#x\\ny#");
    expect(f.cm.getValue()).toBe("x\ny.c\nrest");
    f.ex("2s.\\..!.g");
    expect(f.cm.getValue()).toBe("x\ny!c\nrest");
    f.ex("1,2s/x\\ny/日本語/");
    expect(f.cm.getValue()).toBe("日本語!c\nrest");
    f.ex("%s/^/>/g");
    expect(f.cm.getValue()).toBe(">日本語!c\n>rest");
    f.intact();
  });

  it("reuses the search for an empty pattern and the substitution tuple for bare s", () => {
    const f = create("ONE one\nONE one\nONE one", target);
    f.ex("1s/one/X/giI");
    expect(f.cm.getValue()).toBe("ONE X\nONE one\nONE one");
    f.ex("2s//Y/gIi");
    expect(f.cm.getValue()).toBe("ONE X\nY Y\nONE one");
    f.ex("3s");
    expect(f.cm.getValue()).toBe("ONE X\nY Y\nY Y");
    f.intact();
  });

  it("preserves complete emoji and combining graphemes for empty and partial matches", () => {
    const f = create("👩🏽‍💻é", target);
    f.ex("s/(?=)/x/g");
    expect(f.cm.getValue()).toBe("x👩🏽‍💻xéx");
    undo(f.parent);
    f.ex("s/./x/g");
    expect(f.cm.getValue()).toBe("👩🏽‍💻é");
    f.intact();
  });

  it("rejects a capture producing a lone surrogate before changing any editing state", () => {
    const f = create("😀", target);
    Vim.getRegisterController().getRegister(":").setText("previous");
    Vim.getRegisterController().getRegister("/").setText("search");
    f.ex("s/(.)./$1/");
    expect(f.cm.getValue()).toBe("😀");
    expect(f.errors).toHaveLength(1);
    expect(Vim.getRegisterController().getRegister(":").toString()).toBe("previous");
    expect(Vim.getRegisterController().getRegister("/").toString()).toBe("search");
    expect(undoDepth(f.parent.state)).toBe(0);
    f.intact();
  });

  it("resolves Visual and same-target mark ranges before exiting Visual", async () => {
    const f = create("one\ntwo\nthree", target);
    f.keys("ma");
    f.ex("'a+1,$y b");
    expect(Vim.getRegisterController().getRegister("b").toString()).toBe("two\nthree\n");
    f.cm.setCursor({ line: 1, ch: 0 });
    f.keys("Vj");
    f.ex("'<,'>s/o/O/g");
    expect(f.cm.getValue()).toBe("one\ntwO\nthree");
    expect(f.cm.state.vim!.visualMode).toBe(false);
    await f.settled();
    f.intact();
  });

  it.each(["y", "n", "a", "q", "l", "Escape", "["])(
    "confirmation %s settles or advances without leaking state",
    async (choice) => {
      const f = create("one one one", target);
      f.ex("s/one/X/gc");
      expect(f.cm.state.vim!.exMode).toBe(true);
      f.confirm(choice, choice === "[");
      if (["y", "n"].includes(choice)) f.confirm("q");
      await f.settled();
      expect(f.cm.getValue()).toBe(
        choice === "a" ? "X X X" : ["y", "l"].includes(choice) ? "X one one" : "one one one",
      );
      expect(f.cm.state.vim!.exMode).toBe(false);
      expect(f.cm.state.dialog).toBeFalsy();
      expect(editorSession(f.parent)!.pending.pending).toBe(false);
      f.intact();
    },
  );

  it("keeps accepted confirmations across delays in exactly one Undo", async () => {
    const f = create("one one one", target);
    f.ex("s/one/longer/gc");
    f.confirm("y");
    await f.settled();
    f.confirm("n");
    f.confirm("l");
    await f.settled();
    expect(f.cm.getValue()).toBe("longer one longer");
    expect(undoDepth(f.parent.state)).toBe(1);
    undo(f.parent);
    expect(f.cm.getValue()).toBe("one one one");
    redo(f.parent);
    expect(f.cm.getValue()).toBe("longer one longer");
    f.intact();
  });

  it("leaves the cursor at the last accepted replacement start even when text grows", async () => {
    const f = create("x x", target);
    f.ex("s/x/long/c");
    f.confirm("y");
    await f.settled();
    expect(f.cm.getValue()).toBe("long x");
    expect(f.cm.getCursor()).toMatchObject({ line: 0, ch: 0 });
  });

  it("leaves all observable editing state intact on invalid commands", () => {
    const f = create("one\ntwo", target);
    f.keys("vl");
    const selection = f.cm.getSelection();
    Vim.getRegisterController().getRegister(":").setText("previous");
    Vim.getRegisterController().getRegister("/").setText("search");
    for (const command of ["3d", "2,1d", "'zy", "%s/[/bad/", "%s/o/x/z", "normal dd", "s/o/x/|d"]) {
      f.ex(command);
      expect(f.cm.getValue()).toBe("one\ntwo");
      expect(f.cm.getSelection()).toBe(selection);
      expect(f.cm.state.vim!.visualMode).toBe(true);
      expect(Vim.getRegisterController().getRegister(":").toString()).toBe("previous");
      expect(Vim.getRegisterController().getRegister("/").toString()).toBe("search");
      expect(undoDepth(f.parent.state)).toBe(0);
    }
    f.intact();
  });

  it("handles no-match completion, deletes the entire target, and terminates empty regex matches", () => {
    const f = create("one", target);
    f.ex("s/missing/X/c");
    expect(f.cm.state.vim!.exMode).toBe(false);
    expect(f.cm.state.dialog).toBeFalsy();
    f.ex("%d");
    expect(f.cm.getValue()).toBe("");
    f.ex("s/^$/empty/g");
    expect(f.cm.getValue()).toBe("empty");
    f.intact();
  });
});

it("cancels a confirmation on reset and ignores later dialog keys", async () => {
  const f = create("one one");
  f.ex("s/one/X/gc");
  f.confirm("y");
  const input = f.cm.state.dialog!.querySelector("input")!;
  editorSession(f.parent)!.ex.reset();
  await f.settled();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  expect(f.cm.getValue()).toBe("X one");
  expect(f.cm.state.dialog).toBeFalsy();
  expect(editorSession(f.parent)!.pending.pending).toBe(false);
});

it("reads the clipboard asynchronously for a linewise put", async () => {
  const f = create("one\ntwo");
  const readText = vi.fn().mockResolvedValue("clipboard");
  vi.stubGlobal("navigator", { ...navigator, clipboard: { readText } });
  try {
    f.ex("1put +");
    await f.settled();
    await f.settled();
    expect(f.cm.getValue()).toBe("one\nclipboard\ntwo");
    expect(f.cm.state.vim!.exMode).toBe(false);
    expect(undoDepth(f.parent.state)).toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("aborts confirmation if a note with equal text replaces the original identity", async () => {
  let identity = "first";
  const f = create("one one", "body", () => identity);
  f.ex("s/one/X/gc");
  identity = "second";
  f.confirm("y");
  await f.settled();
  expect(f.cm.getValue()).toBe("one one");
  expect(f.cm.state.vim!.exMode).toBe(false);
  expect(editorSession(f.parent)!.pending.pending).toBe(false);
});

it("aborts confirmation after an external edit without moving its cursor or overwriting it", async () => {
  const f = create("one one");
  f.ex("s/one/X/gc");
  f.parent.dispatch({ changes: { from: 0, insert: "external " }, selection: { anchor: 2 } });
  f.confirm("a");
  await f.settled();
  expect(f.cm.getValue()).toBe("external one one");
  expect(f.cm.getCursor()).toMatchObject({ line: 0, ch: 2 });
  expect(f.errors).toHaveLength(1);
  expect(f.cm.state.dialog).toBeFalsy();
});

it("reset cancels a delayed clipboard put without affecting a later command", async () => {
  const f = create("one\ntwo");
  let resolve!: (text: string) => void;
  vi.stubGlobal("navigator", {
    ...navigator,
    clipboard: {
      readText: () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    },
  });
  try {
    f.ex("put +");
    editorSession(f.parent)!.ex.reset();
    f.ex("1s/one/changed/");
    resolve("obsolete");
    await f.settled();
    await f.settled();
    expect(f.cm.getValue()).toBe("changed\ntwo");
    expect(f.cm.state.vim!.exMode).toBe(false);
    expect(editorSession(f.parent)!.pending.pending).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
