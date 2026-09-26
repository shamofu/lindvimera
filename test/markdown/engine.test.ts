import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { getCM, vim, vimTarget, Vim } from "@replit/codemirror-vim";
import { configureMarkdown, installMarkdownCommands } from "../../src/markdown";
import { installWordProvider } from "../../src/word";
import { structureEditingCases } from "../probe/structure-cases";

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

  it.each([
    ["# First\nbody\n\n# Next\nlast", 8, "dah", "# Next\nlast"],
    ["# First\n\nbody\n\n# Next\nlast", 10, "dih", "# First\n\n\n# Next\nlast"],
    ["- [ ] first\n  - child\n- next", 7, "diL", "- [ ] \n- next"],
    ["- [ ] first\n  - child\n\n- next", 17, "daL", "- [ ] first\n- next"],
    ["# First\nbody\n# Last\nend", 22, "dah", "# First\nbody"],
  ])("edits block object %s with %s", (text, at, command, expected) => {
    const { cm } = editor(text as string, at as number);
    keys(cm, command as string);
    expect(cm.getValue()).toBe(expected);
  });
  it("stores whole subtrees as linewise registers and pastes them as complete lines", () => {
    const { cm } = editor("# First\nbody\n# Next\nlast", 8);
    keys(cm, '"ayah');
    const register = Vim.getRegisterController().getRegister("a");
    expect(register.toString()).toBe("# First\nbody\n");
    expect(register.linewise).toBe(true);
    cm.setCursor({ line: 3, ch: 0 });
    keys(cm, '"ap');
    expect(cm.getValue()).toBe("# First\nbody\n# Next\nlast\n# First\nbody");
  });
  it("changes the entire loose item when a later paragraph starts with a checkbox", () => {
    const source = "- first\n  - child\n\n  [ ] later\n- next";
    const { cm, view } = editor(source, 2);
    keys(cm, "ciL");
    expect(cm.getValue()).toBe("- \n- next");
    expect(cm.state.vim?.insertMode).toBe(true);
    expect(Vim.getRegisterController().getRegister().toString()).toBe(
      "first\n  - child\n\n  [ ] later",
    );
    cm.replaceSelection("replacement");
    keys(cm, "<Esc>");
    expect(cm.getValue()).toBe("- replacement\n- next");
    undo(view);
    expect(cm.getValue()).toBe(source);
  });
  it("changes only the body and groups the replacement into one Undo", () => {
    const source = "# First\nbody\n# Next\nlast";
    const { cm, view } = editor(source, 9);
    keys(cm, "cih");
    expect(cm.state.vim?.insertMode).toBe(true);
    cm.replaceSelection("replacement");
    keys(cm, "<Esc>");
    expect(cm.getValue()).toBe("# First\nreplacement\n# Next\nlast");
    undo(view);
    expect(cm.getValue()).toBe(source);
  });
  it.each(["vih", "Vih", "<C-v>ih", "vah", "vaL", "<C-v>aL"])(
    "turns structural selection %s into Visual Line",
    (command) => {
      const source = command.includes("L") ? "- first\n  - child\n- next" : "# First\nbody\n# Next";
      const { cm } = editor(source, source.indexOf(command.includes("L") ? "first" : "body"));
      keys(cm, command);
      expect(cm.state.vim?.visualMode).toBe(true);
      expect(cm.state.vim?.visualLine).toBe(true);
      expect(cm.state.vim?.visualBlock).toBe(false);
      keys(cm, "y");
      expect(Vim.getRegisterController().getRegister().linewise).toBe(true);
      expect(Vim.getRegisterController().getRegister().toString()).not.toContain("Next");
    },
  );
  it.each(["viL", "ViL", "<C-v>iL"])(
    "selects complete graphemes and content characterwise with %s",
    (command) => {
      const { cm } = editor("- [x] e\u0301👨‍👩‍👧‍👦\n- next", 6);
      keys(cm, command);
      expect(cm.state.vim?.visualLine).toBe(false);
      expect(cm.state.vim?.visualBlock).toBe(false);
      keys(cm, "d");
      expect(cm.getValue()).toBe("- [x] \n- next");
    },
  );
  it("multiplies counts to climb actual parents without consuming siblings", () => {
    const source = "# One\n## Two\n### Three\n#### Four\nbody\n# Next";
    const { cm } = editor(source, source.indexOf("body"));
    keys(cm, "2y2ah");
    expect(Vim.getRegisterController().getRegister().toString()).toBe(
      source.slice(0, source.indexOf("# Next")),
    );
    keys(cm, "5dah");
    expect(cm.getValue()).toBe(source);
    expect(cm.state.vim?.insertMode).toBe(false);
  });
  it("uses the normal case and indentation operators for section contents", () => {
    const { cm } = editor("# First\nbody\n# Next\nlast", 9);
    keys(cm, "gUih");
    expect(cm.getValue()).toBe("# First\nBODY\n# Next\nlast");
    keys(cm, ">ih");
    expect(cm.getValue()).toBe("# First\n  BODY\n# Next\nlast");
  });
  it("rebuilds structural ranges only after the source document changes", () => {
    const { cm, view } = editor("# First\nbody\n# Next\nlast", 9);
    const read = vi.spyOn(cm, "getValue");
    keys(cm, "vah<Esc>vah<Esc>");
    expect(read).toHaveBeenCalledTimes(1);
    view.dispatch({ changes: { from: 8, to: 12, insert: "longer body" } });
    cm.setCursor({ line: 1, ch: 0 });
    keys(cm, "yih");
    expect(Vim.getRegisterController().getRegister().toString()).toBe("longer body\n");
  });
  it.each([
    ["# Empty\n\n# Next", "cih"],
    ["- [ ] ", "ciL"],
    ["prologue\n# First\nbody", "cah"],
    ["plain paragraph", "caL"],
    ["# First\nbody", "c2ah"],
  ])("does not enter Insert or modify registers for missing content in %s", (source, command) => {
    const { cm } = editor(source);
    Vim.getRegisterController().getRegister().setText("retained");
    keys(cm, command);
    expect(cm.getValue()).toBe(source);
    expect(cm.state.vim?.insertMode).toBe(false);
    expect(cm.state.vim?.inputState.operator).toBeFalsy();
    expect(Vim.getRegisterController().getRegister().toString()).toBe("retained");
  });
  it("recomputes section ranges for dot and macro replay", () => {
    const source = "# One\na\n# Two\nb\nb\n# Three\nc\nc\nc\n# Last\nz";
    const { cm, view } = editor(source);
    keys(cm, "qadahq");
    expect(cm.getValue()).toBe(source.slice(source.indexOf("# Two")));
    keys(cm, ".");
    expect(cm.getValue()).toBe(source.slice(source.indexOf("# Three")));
    keys(cm, "@a");
    expect(cm.getValue()).toBe("# Last\nz");
    undo(view);
    expect(cm.getValue()).toBe(source.slice(source.indexOf("# Three")));
  });
  it("retains existing link objects and respects the per-editor text-object setting", () => {
    const { cm } = editor("# Heading\n[label](url)", 12);
    keys(cm, "yil");
    expect(Vim.getRegisterController().getRegister().toString()).toBe("label");
    configureMarkdown(cm, { motions: true, textObjects: false, surround: true });
    keys(cm, "dah");
    expect(cm.getValue()).toBe("# Heading\n[label](url)");
  });
  it("keeps structural commands inert in a native cell while inline objects still work", () => {
    const { cm, view } = editor("# Parent\nbody");
    const cell = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "# Cell\n- **value**",
        extensions: [vimTarget(() => cm)],
      }),
    });
    views.push(cell);
    cm.editingViewProvider = () => cell;
    cm.refreshEditingTarget();
    keys(cm, "cahcaL");
    expect(cm.state.vim?.insertMode).toBe(false);
    expect(cell.state.doc.toString()).toBe("# Cell\n- **value**");
    expect(view.state.doc.toString()).toBe("# Parent\nbody");
    cm.setCursor({ line: 1, ch: 5 });
    keys(cm, "di*");
    expect(cell.state.doc.toString()).toBe("# Cell\n- ****");
  });
  it.each(structureEditingCases)("exercises the shared host case $keys in $text", (example) => {
    const { cm, view } = editor(example.text);
    keys(cm, example.keys);
    expect(cm.getValue()).toBe(example.result);
    undo(view);
    expect(cm.getValue()).toBe(example.text);
  });
  it("selects complete list graphemes with the Japanese word provider enabled", () => {
    const { cm } = editor("- [ ] e\u0301👨‍👩‍👧‍👦\n- next", 6);
    installWordProvider(cm);
    keys(cm, "viLd");
    expect(cm.getValue()).toBe("- [ ] \n- next");
  });
});
