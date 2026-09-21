import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { installWordProvider, WordBoundaryCache, type WordDocument } from "../../src/word";
import { createSentenceProvider } from "../../src/word/sentence";

function textDocument(text: string): WordDocument {
  const lines = text.split("\n");
  return { getLine: (line) => lines[line], firstLine: () => 0, lastLine: () => lines.length - 1 };
}

function sentence(text: string, offset: number, inclusive = false, repeat = 1, japanese = true) {
  const document = textDocument(text);
  const provider = createSentenceProvider(new WordBoundaryCache(512, 262_144, japanese));
  const range = provider.expand(document, { line: 0, ch: offset }, { inclusive, repeat });
  if (!range) return null;
  const position = (line: number, ch: number) =>
    text
      .split("\n")
      .slice(0, line)
      .reduce((sum, text) => sum + text.length + 1, ch);
  return text.slice(
    position(range.start.line, range.start.ch),
    position(range.end.line, range.end.ch),
  );
}

describe("shared sentence boundaries", () => {
  it.each([
    ["今日は晴れ。明日も晴れ！", 2, "今日は晴れ。"],
    ["今日は晴れ。明日も晴れ！", 6, "明日も晴れ！"],
    ["「本当！？」次です。", 3, "「本当！？」"],
    ["（『本当！！？』）次です。", 6, "（『本当！！？』）"],
    ['"Really?!") Next.', 4, '"Really?!")'],
    ["a.b is one. Next.", 3, "a.b is one."],
    ["One\ncontinued! Next.", 3, "One\ncontinued!"],
    ["One\n\nSecond.", 1, "One"],
    ["  First.  Second.  ", 4, "First."],
    ["First.  Second.  ", 7, "  "],
    ["👩🏽‍💻がいます。🇯🇵です！", 1, "👩🏽‍💻がいます。"],
    ["一文。́二文！️三文。", 0, "一文。́"],
    ["一文。́二文！️三文。", 4, "二文！️"],
  ])("selects the complete inner sentence in %s at %i", (text, offset, expected) => {
    expect(sentence(text as string, offset as number)).toBe(expected);
  });

  it("shares ASCII punctuation rules when Japanese handling is disabled", () => {
    expect(sentence("一文。二文！三文？ Next.", 0, false, 1, false)).toBe(
      "一文。二文！三文？ Next.",
    );
    expect(sentence("one.two. Next.", 0, false, 1, false)).toBe("one.two.");
    expect(sentence('First.)"  Next.', 0, false, 1, false)).toBe('First.)"');
  });

  it("counts inner whitespace objects and around sentences separately", () => {
    expect(sentence("First.  Second. Third.", 0, false, 2)).toBe("First.  ");
    expect(sentence("First.  Second. Third.", 0, false, 3)).toBe("First.  Second.");
    expect(sentence("First.  Second. Third.", 0, true, 2)).toBe("First.  Second. ");
    expect(sentence("First.  Second. Third.", 6, true)).toBe("  Second.");
    expect(sentence("First.  Second. Third.", 16, true)).toBe(" Third.");
    expect(sentence("一文。二文。三文。", 0, false, 2)).toBe("一文。二文。");
  });

  it("includes trailing whitespace, or preceding whitespace at the last sentence", () => {
    expect(sentence("  First.  Last.", 4, true)).toBe("First.  ");
    expect(sentence("  First.  Last.", 12, true)).toBe("  Last.");
    expect(sentence("  First.  Last.", 4, true, 2)).toBe("  First.  Last.");
    expect(sentence("First.\n  Next.", 0, true)).toBe("First.\n  ");
    expect(sentence("", 0)).toBeNull();
    expect(sentence(" ", 0)).toBe(" ");
  });

  it("handles nonzero document first lines and preserves grapheme endpoints", () => {
    const provider = createSentenceProvider(new WordBoundaryCache());
    const document: WordDocument = {
      firstLine: () => 5,
      lastLine: () => 5,
      getLine: () => "一文。👩🏽‍💻",
    };
    expect(provider.move(document, { line: 5, ch: 0 }, { repeat: 1, forward: true })).toEqual({
      line: 5,
      ch: 3,
    });
    expect(provider.move(document, { line: 5, ch: 3 }, { repeat: 9, forward: true })).toEqual({
      line: 5,
      ch: 3,
    });
    expect(provider.character(document, { line: 5, ch: 5 }, 0)).toEqual({ line: 5, ch: 3 });
  });
});

const views: EditorView[] = [];
function editor(text: string, japanese = true): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc: text, extensions: [history(), vim()] }),
  });
  views.push(view);
  installWordProvider(getCM(view)!, new WordBoundaryCache(512, 262_144, japanese));
  return view;
}

function keys(view: EditorView, sequence: string): void {
  const cm = getCM(view)!;
  for (const key of sequence.match(/<[^>]+>|./gu) ?? [])
    cm.operation(() => Vim.handleKey(cm, key, "user"));
}

beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
beforeEach(() => Vim.resetVimGlobalState_());
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("sentence and paragraph editing through Vim", () => {
  it("moves over punctuation runs, closing brackets and empty-line runs in both directions", () => {
    const view = editor("「晴れ！？」明日も晴れ。\n\n\n最後です。 続き。👩🏽‍💻");
    const cm = getCM(view)!;
    keys(view, ")");
    expect(cm.getCursor()).toMatchObject({ line: 0, ch: 6 });
    keys(view, ")");
    expect(cm.getCursor()).toMatchObject({ line: 1, ch: 0 });
    keys(view, ")");
    expect(cm.getCursor()).toMatchObject({ line: 3, ch: 0 });
    keys(view, "2)");
    expect(cm.getCursor()).toMatchObject({ line: 3, ch: 9 });
    keys(view, "3(");
    expect(cm.getCursor()).toMatchObject({ line: 2, ch: 0 });
    keys(view, "(");
    expect(cm.getCursor()).toMatchObject({ line: 0, ch: 6 });
  });

  it.each(["dis", "visd", "v2lisd"])("%s preserves a sentence-ending emoji cluster", (command) => {
    const view = editor("👩🏽‍💻が好きです。次です！");
    keys(view, command);
    expect(view.state.doc.toString()).toBe("次です！");
  });

  it("records counted sentence operators into named registers and dot repeat", () => {
    const view = editor("一。二。三。四。五。六。七。八。九。");
    keys(view, '"a2d2is');
    expect(Vim.getRegisterController().getRegister("a").toString()).toBe("一。二。三。四。");
    expect(view.state.doc.toString()).toBe("五。六。七。八。九。");
    keys(view, ".");
    expect(view.state.doc.toString()).toBe("九。");
    keys(view, "u");
    expect(view.state.doc.toString()).toBe("五。六。七。八。九。");
    keys(view, "<C-r>");
    expect(view.state.doc.toString()).toBe("九。");
  });

  it("replays sentence edits in macros and mappings", () => {
    const view = editor("一。二。三。四。五。");
    keys(view, "qadisq@a");
    expect(view.state.doc.toString()).toBe("三。四。五。");
    Vim.map("Q", "dis", "normal");
    keys(view, "Q");
    expect(view.state.doc.toString()).toBe("四。五。");
  });

  it("expands Visual sentence objects forwards and backwards without losing the anchor", () => {
    const view = editor("一文。二文。三文。四文。");
    const cm = getCM(view)!;
    keys(view, "visis");
    expect(cm.getSelection()).toBe("一文。二文。");
    keys(view, "is");
    expect(cm.getSelection()).toBe("一文。二文。三文。");
    keys(view, "ois");
    expect(cm.getSelection()).toBe("一文。二文。三文。");
    expect(cm.state.vim!.sel.head.ch).toBe(0);
    keys(view, "<Esc>");
    cm.setCursor({ line: 0, ch: 8 });
    keys(view, "vhis");
    expect(cm.getSelection()).toBe("三文。");
    keys(view, "is");
    expect(cm.getSelection()).toBe("二文。三文。");
  });

  it.each(["Vis", "Vas", "<C-v>is", "<C-v>as"])(
    "switches %s to characterwise Visual like native Vim",
    (command) => {
      const view = editor("一文。二文。\n三文。四文。");
      keys(view, command);
      expect(getCM(view)!.state.vim).toMatchObject({
        visualMode: true,
        visualLine: false,
        visualBlock: false,
      });
      expect(getCM(view)!.getSelection()).toBe("一文。");
      keys(view, "y");
      expect(Vim.getRegisterController().getRegister('"').toString()).toBe("一文。");
      expect(Vim.getRegisterController().getRegister('"').linewise).toBe(false);
    },
  );

  it("sentence change enters Insert and repeats after a native edit", () => {
    const view = editor("一文。二文。三文。");
    const cm = getCM(view)!;
    keys(view, "cis");
    expect(cm.state.vim!.insertMode).toBe(true);
    cm.operation(() => cm.replaceSelection("変更。"));
    keys(view, "<Esc>)");
    keys(view, ".");
    expect(view.state.doc.toString()).toBe("変更。変更。三文。");
  });

  it("uses whitespace-only lines as paragraph object boundaries while motions cross them", () => {
    const view = editor("one\n  \ntwo\n\nthree");
    const cm = getCM(view)!;
    keys(view, "}");
    expect(cm.getCursor()).toMatchObject({ line: 3, ch: 0 });
    keys(view, "ggdip");
    expect(view.state.doc.toString()).toBe("  \ntwo\n\nthree");
    expect(Vim.getRegisterController().getRegister('"').toString()).toBe("one\n");
    expect(Vim.getRegisterController().getRegister('"').linewise).toBe(true);
    keys(view, "u");
    keys(view, "ggdap");
    expect(view.state.doc.toString()).toBe("two\n\nthree");
    keys(view, "vipipy");
    expect(Vim.getRegisterController().getRegister('"').toString()).toBe("two\n\n");
  });

  it.each(["d_", "d+", "d-"])("uses a linewise register for %s", (command) => {
    const view = editor("one\ntwo\nthree");
    getCM(view)!.setCursor({ line: 1, ch: 1 });
    keys(view, command);
    expect(Vim.getRegisterController().getRegister('"').linewise).toBe(true);
    expect(view.state.doc.toString()).toBe(
      command === "d_" ? "one\nthree" : command === "d+" ? "one" : "three",
    );
  });
});
