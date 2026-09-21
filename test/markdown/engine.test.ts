import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { configureMarkdown, installMarkdownCommands } from "../../src/markdown";
import { installWordProvider } from "../../src/word";

const views: EditorView[] = [];
function editor(text: string, at = 0) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      selection: { anchor: at },
      extensions: [history(), vim()],
    }),
  });
  views.push(view);
  const cm = getCM(view)!;
  configureMarkdown(cm, { motions: true, textObjects: true, surround: true });
  return { view, cm };
}
function keys(cm: NonNullable<ReturnType<typeof getCM>>, values: string) {
  for (const value of values.match(/<[^>]+>|./g) ?? [])
    cm.operation(() => Vim.handleKey(cm, value, "user"));
}

describe("Markdown commands in the actual Vim dispatcher", () => {
  beforeAll(() => {
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect ??= () => new DOMRect();
    installMarkdownCommands();
  });
  beforeEach(() => Vim.resetVimGlobalState_());
  afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
    document.body.replaceChildren();
  });

  it("counts heading motions and ignores headings in code and frontmatter", () => {
    const { cm } = editor("start\n```md\n# fake\n```\n# First\n## Second\n# Third");
    keys(cm, "2]h");
    expect(cm.getCursor()).toMatchObject({ line: 5, ch: 3 });
    keys(cm, "[h");
    expect(cm.getCursor()).toMatchObject({ line: 4, ch: 2 });
  });
  it("moves between list siblings using the real ordered/task prefix", () => {
    const { cm } = editor("1. first\n   - nested\n12. [x] second\n13. third", 3);
    keys(cm, "]l");
    expect(cm.getCursor()).toMatchObject({ line: 2, ch: 8 });
  });
  it.each([
    ["**word**", 3, "di*", "****"],
    ["_word_", 2, "da_", ""],
    ["`word`", 2, "di`", "``"],
    ["[word](https://example.com)", 2, "dil", "[](https://example.com)"],
    ["[[word]]", 3, "dal", ""],
    ["```ts\nword\n```", 8, "diC", "```ts\n\n```"],
  ])("edits %s through text objects and registers", (text, at, command, expected) => {
    const { cm } = editor(text as string, at as number);
    keys(cm, command as string);
    expect(cm.getValue()).toBe(expected);
    expect(Vim.getRegisterController().getRegister().toString()).not.toBe("");
  });
  it("retains named-register handling and visual text-object boundaries", () => {
    const { cm } = editor("**word**", 3);
    keys(cm, '"ayi*');
    expect(Vim.getRegisterController().getRegister("a").toString()).toBe("word");
    keys(cm, "vi*y");
    expect(Vim.getRegisterController().getRegister().toString()).toBe("word");
  });
  it.each([
    ["word next", "ysiw)", "(word) next"],
    ["word next", "2ysiw*", "*word *next"],
    ["word next", "ysiw(", "( word ) next"],
    ["  word next\nlast", 'yss"', '  "word next"\nlast'],
    ["word next", "viwgS]", "[word] next"],
    ["**word**", "ds*", "word"],
    ["**word**", "2ds*", "**word**"],
    ["((word))", "2ds)", "(word)"],
    ["( word )", "ds(", "word"],
    ["( word )", "ds)", " word "],
    ['"word"', "cs\"'", "'word'"],
    ["**word**", "cs*)", "(word)"],
    ["***word***", "ds*", "word"],
    ["**outer *word* end**", "2ds*", "outer *word* end"],
  ])("surround %s with %s uses ordinary ranges and nesting", (text, command, expected) => {
    const { cm } = editor(text, text.indexOf("word"));
    keys(cm, command);
    expect(cm.getValue()).toBe(expected);
    expect(cm.state.vim?.insertMode).toBe(false);
  });
  it("replays surround via dot and macros without consuming replacement as a command", () => {
    const { cm } = editor("one two three");
    keys(cm, "qaysiw)q");
    expect(cm.getValue()).toBe("(one) two three");
    cm.setCursor({ line: 0, ch: cm.getValue().indexOf("two") });
    keys(cm, ".");
    expect(cm.getValue()).toContain("(two)");
    cm.setCursor({ line: 0, ch: cm.getValue().indexOf("three") });
    keys(cm, "@a");
    expect(cm.getValue()).toBe("(one) (two) (three)");
  });
  it("replays change/delete surroundings and keeps a single undo group", () => {
    const { cm, view } = editor('"one" "two"', 2);
    keys(cm, "cs\"'");
    expect(cm.getValue()).toBe("'one' \"two\"");
    cm.setCursor({ line: 0, ch: 8 });
    keys(cm, ".");
    expect(cm.getValue()).toBe("'one' 'two'");
    undo(view);
    expect(cm.getValue()).toBe("'one' \"two\"");
  });
  it("leaves Normal and Visual S intact and respects features per editor", () => {
    const { cm } = editor("word");
    keys(cm, "S");
    expect(cm.state.vim?.insertMode).toBe(true);
    const visual = editor("word next").cm;
    keys(visual, "viwS");
    expect(visual.getValue()).toBe("\n");
    expect(visual.state.vim?.insertMode).toBe(true);
    const second = editor("word").cm;
    configureMarkdown(second, { motions: false, textObjects: false, surround: false });
    keys(second, "ysiw)");
    expect(second.getValue()).toBe("word");
  });
  it("multiplies operator and motion counts without repeating delimiters", () => {
    const { cm } = editor("one two three");
    keys(cm, "2ys2iw*");
    // The upstream iw count includes the whitespace objects between words.
    expect(cm.getValue()).toBe("*one two *three");
  });
  it("repeats visual surround through the retained selection shape", () => {
    const { cm } = editor("one two");
    keys(cm, "viwgS)");
    cm.setCursor({ line: 0, ch: 6 });
    keys(cm, ".");
    expect(cm.getValue()).toBe("(one) (two)");
  });
  it("cancels a deferred surround after an external document change", () => {
    const { cm, view } = editor("one two");
    keys(cm, "ysiw");
    view.dispatch({ changes: { from: 0, to: 3, insert: "new" } });
    keys(cm, ")");
    expect(cm.getValue()).toBe("new two");
    expect(cm.state.vim?.expectLiteralNext).toBe(false);
  });
  it.each(["<Esc>", "<C-c>"])("cancels a pending surround with %s", (cancel) => {
    const { cm } = editor("one two");
    keys(cm, `ysiw${cancel}w`);
    expect(cm.getValue()).toBe("one two");
    expect(cm.getCursor()).toMatchObject({ line: 0, ch: 4 });
    expect(cm.state.vim?.expectLiteralNext).toBe(false);
  });
  it("replays counted add and nested change using fresh ranges and one undo per edit", () => {
    const { cm, view } = editor("one two three four");
    keys(cm, "2ysw)");
    expect(cm.getValue()).toBe("(one two )three four");
    cm.setCursor({ line: 0, ch: cm.getValue().indexOf("three") });
    keys(cm, ".");
    expect(cm.getValue()).toBe("(one two )(three four)");
    undo(view);
    expect(cm.getValue()).toBe("(one two )three four");

    const nested = editor("((one)) ((two))", 3);
    keys(nested.cm, "2cs)]");
    expect(nested.cm.getValue()).toBe("[(one)] ((two))");
    nested.cm.setCursor({ line: 0, ch: nested.cm.getValue().indexOf("two") });
    keys(nested.cm, ".");
    expect(nested.cm.getValue()).toBe("[(one)] [(two)]");
    undo(nested.view);
    expect(nested.cm.getValue()).toBe("[(one)] ((two))");
  });
  it("opens internal links from current text through the host callback without editing", () => {
    const { cm, view } = editor("[[Old note|label]]", 6);
    const openLink = vi.fn();
    configureMarkdown(cm, { motions: true, textObjects: true, surround: true, openLink });
    view.dispatch({ changes: { from: 2, to: 10, insert: "New note#Heading" } });
    cm.setCursor({ line: 0, ch: 5 });
    keys(cm, "gf");
    expect(openLink).toHaveBeenCalledExactlyOnceWith("New note#Heading");
    expect(cm.getValue()).toBe("[[New note#Heading|label]]");
    expect(cm.state.vim?.insertMode).toBe(false);
  });
  it.each([true, false])("preserves complete graphemes in visual objects (BudouX %s)", (budoux) => {
    const { cm } = editor("**e\u0301👨‍👩‍👧‍👦**", 2);
    if (budoux) installWordProvider(cm);
    keys(cm, "vi*d");
    expect(cm.getValue()).toBe("****");
  });
  it("reuses the structural index while a large document is unchanged", () => {
    const { cm } = editor(
      Array.from({ length: 1000 }, (_, n) => `# Heading ${n}\nparagraph`).join("\n"),
    );
    const read = vi.spyOn(cm, "getValue");
    keys(cm, "]h]h[h");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
