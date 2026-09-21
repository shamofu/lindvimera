import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { installWordProvider, wordSpans } from "../../src/word";

const views: EditorView[] = [];
function editor(text: string, enabled = true): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: text, extensions: [history(), vim()] }),
  });
  views.push(view);
  if (enabled) installWordProvider(getCM(view)!);
  return view;
}

function keys(view: EditorView, text: string): void {
  const cm = getCM(view)!;
  for (const key of text.match(/<[^>]+>|./gu) ?? [])
    cm.operation(() => Vim.handleKey(cm, key, "user"));
}

function at(view: EditorView, ch: number, line = 0): void {
  getCM(view)!.setCursor({ line, ch });
}

function head(view: EditorView): { line: number; ch: number } {
  const { line, ch } = getCM(view)!.getCursor();
  return { line, ch };
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

describe("word policy through the real Vim dispatcher", () => {
  const text = "今日は良い天気です。明日も晴れます。";

  it("w b e ge and explicit counts follow Japanese chunks", () => {
    const view = editor(text);
    const spans = wordSpans(text);
    keys(view, "2w");
    expect(head(view).ch).toBe(spans[2].from);
    keys(view, "e");
    expect(head(view).ch).toBe(spans[2].last);
    keys(view, "b");
    expect(head(view).ch).toBe(spans[2].from);
    keys(view, "ge");
    expect(head(view).ch).toBe(spans[1].last);
  });

  it("operator and motion counts multiply using existing registers and dot replay", () => {
    const view = editor(`${text} ${text}`);
    const spans = wordSpans(view.state.doc.toString());
    keys(view, '"a2d2w');
    expect(Vim.getRegisterController().getRegister("a").toString()).toBe(
      text.slice(0, spans[4].from),
    );
    expect(view.state.doc.toString()).toBe(`${text} ${text}`.slice(spans[4].from));
    keys(view, ".");
    expect(view.state.doc.toString()).toBe(`${text} ${text}`.slice(spans[8].from));
  });

  it("iw aw, visual objects, and cw use the same boundary policy", () => {
    const view = editor(`  ${text}  next`);
    at(view, 3);
    keys(view, "viw");
    expect(getCM(view)!.getSelection()).toBe("今日は");
    keys(view, "<Esc>");
    at(view, 2);
    keys(view, "daw");
    expect(view.state.doc.toString()).toBe(`  ${text.slice(3)}  next`);
    keys(view, "cw");
    expect(getCM(view)!.state.vim!.insertMode).toBe(true);
    expect(view.state.doc.toString()).toBe(`  ${text.slice(5)}  next`);
  });

  it.each([
    "# 日本語の文節を操作します。",
    "`日本語の文節を操作します。`",
    "https://example.com/日本語の文節",
    "title: 日本語の文節",
    "| 日本語の文節 | text |",
  ])("uses Japanese word boundaries in Markdown-like plain text: %s", (source) => {
    const view = editor(source);
    const spans = wordSpans(source);
    at(view, spans.find((span) => /日/.test(source.slice(span.from, span.to)))!.from);
    const position = head(view).ch;
    keys(view, "diw");
    const selected = spans.find((span) => span.from === position)!;
    expect(view.state.doc.toString()).toBe(
      source.slice(0, selected.from) + source.slice(selected.to),
    );
  });

  it.each(["日本語が好きです。", "日本語👨‍👩‍👧‍👦の文章", "私は🍣が好きです。", "é 👩🏽‍💻 🇯🇵"])(
    "inclusive and exclusive word edits preserve graphemes: %s",
    (source) => {
      const spans = wordSpans(source);
      const span = spans[0];
      for (const command of ["de", "diw", "viwd"]) {
        const view = editor(source);
        keys(view, command);
        const selected = command === "de" && span.last === 0 ? spans[1] : span;
        expect(view.state.doc.toString()).toBe(source.slice(selected.to));
      }
    },
  );

  it.each([
    "w",
    "b",
    "e",
    "ge",
    "2w",
    "2b",
    "2e",
    "2ge",
    "diw",
    "daw",
    "cw",
    "dw",
    "de",
    "viw",
    "vaw",
  ])("retains legacy English behavior for %s", (command) => {
    const source = "  alpha-beta  gamma\n\n delta_epsilon z!\nlast";
    for (const position of [0, 2, 3, 6, 7, 11, 12, 14, 18]) {
      const original = editor(source, false);
      const updated = editor(source);
      at(original, position);
      at(updated, position);
      keys(original, command);
      keys(updated, command);
      expect({
        text: updated.state.doc.toString(),
        head: head(updated),
        selected: getCM(updated)!.getSelection(),
      }).toEqual({
        text: original.state.doc.toString(),
        head: head(original),
        selected: getCM(original)!.getSelection(),
      });
    }
  });

  it.each(["W", "B", "E", "gE", "diW", "daW", "*"])(
    "does not change WORD or search rules for %s",
    (command) => {
      const source = `${text} other ${text}`;
      const original = editor(source, false);
      const updated = editor(source);
      keys(original, command);
      keys(updated, command);
      expect(updated.state.doc.toString()).toBe(original.state.doc.toString());
      expect(head(updated)).toEqual(head(original));
    },
  );

  it("keeps macro recording on the original execution path", () => {
    const view = editor(`${text} ${text}`);
    keys(view, "qadwq@a");
    expect(view.state.doc.toString()).toBe(`${text} ${text}`.slice(5));
    expect(Vim.getRegisterController().getRegister("a").keyBuffer.join("")).toBe("dw");
  });

  it("grapheme clipping does not trap h/l inside combining or emoji sequences", () => {
    const view = editor("é👩🏽‍💻日本語");
    keys(view, "l");
    expect(head(view).ch).toBe(2);
    keys(view, "l");
    expect(head(view).ch).toBe(9);
    keys(view, "h");
    expect(head(view).ch).toBe(2);
    keys(view, "h");
    expect(head(view).ch).toBe(0);
  });

  it.each(["x", "dd", "cc", "D", "C", "Vd", "v$d"])(
    "does not affect ordinary ASCII edits at the document end: %s",
    (command) => {
      const original = editor("first\nlast", false);
      const updated = editor("first\nlast");
      at(original, 0, 1);
      at(updated, 0, 1);
      keys(original, command);
      keys(updated, command);
      expect(updated.state.doc.toString()).toBe(original.state.doc.toString());
      expect(head(updated)).toEqual(head(original));
    },
  );
});
