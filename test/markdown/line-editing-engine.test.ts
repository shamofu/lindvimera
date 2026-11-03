import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { configureMarkdown, installMarkdownCommands, clearMarkdown } from "../../src/markdown";
import type { MarkdownEditingHost } from "../../src/markdown/editing-runtime";

const views: EditorView[] = [];
function editor(text: string, at = 0, host?: MarkdownEditingHost) {
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
  // jsdom has no line geometry; keep the host layout boundary deterministic.
  if (host)
    cm.findPosV = (head, amount) => ({
      line: Math.max(0, Math.min(view.state.doc.lines - 1, head.line + amount)),
      ch: head.ch,
    });
  const configure = (editing = true) =>
    configureMarkdown(cm, { motions: true, textObjects: true, surround: true, editing, host });
  configure();
  return {
    view,
    cm,
    configure,
    keys(sequence: string) {
      for (const token of sequence.match(/<[^>]+>|./gu) ?? []) {
        if (cm.state.vim?.insertMode && !token.startsWith("<"))
          view.dispatch(view.state.replaceSelection(token), {
            annotations: Transaction.userEvent.of("input.type"),
          });
        else cm.operation(() => Vim.handleKey(cm, token, "user"));
      }
    },
  };
}

beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  installMarkdownCommands();
});
beforeEach(() => Vim.resetVimGlobalState_());
afterEach(() => {
  for (const view of views.splice(0)) {
    clearMarkdown(getCM(view)!);
    view.destroy();
  }
  document.body.replaceChildren();
});

describe("Markdown line editing through the actual Vim dispatcher", () => {
  it("opens below through host Enter at EOL without applying local renumbering", () => {
    const e = editor("1. first\n2. next", 3, {
      smartLists: () => true,
      livePreview: () => true,
      enter() {
        expect(e.cm.getCursor()).toMatchObject({ line: 0, ch: 8 });
        e.view.dispatch(e.view.state.replaceSelection("\nHOST "));
        return true;
      },
      indent: () => false,
    });
    e.keys("oadded<Esc>");
    expect(e.cm.getValue()).toBe("1. first\nHOST added\n2. next");
  });

  it("keeps host Smart Lists OFF semantics on open below and dot replay", () => {
    const e = editor("- first", 0, {
      smartLists: () => false,
      livePreview: () => false,
      enter() {
        e.view.dispatch(e.view.state.replaceSelection("\n"));
        return true;
      },
      indent: () => false,
    });
    e.keys("oX<Esc>.");
    expect(e.cm.getValue()).toBe("- first\nX\nX");
  });

  it("retains O task prefixes while leaving native ordered renumbering to the host", () => {
    const e = editor("9. [x] first\n10. next", 0, {
      smartLists: () => true,
      livePreview: () => true,
      enter: () => {
        throw new Error("O must not send Enter");
      },
      indent: () => false,
    });
    e.keys("Oadded<Esc>");
    expect(e.cm.getValue()).toBe("9. [ ] added\n9. [x] first\n10. next");
  });

  it("keeps the content-relative column across unequal Live Preview list prefixes", () => {
    const e = editor("9. abcdef\n10. [ ] abcdef\n11. abcdef\n12. x\n13. abcdef", 5, {
      smartLists: () => true,
      livePreview: () => true,
      enter: () => false,
      indent: () => false,
    });
    for (const ch of [10, 6, 4, 6]) {
      e.keys("j");
      expect(e.cm.getCursor().ch).toBe(ch);
    }
    e.keys("2k");
    expect(e.cm.getCursor()).toMatchObject({ line: 2, ch: 6 });
  });

  it("keeps Source columns and operator j/k on physical lines", () => {
    let live = false;
    const e = editor("- abcdef\n- [ ] abcdef\n123. abcdef", 4, {
      smartLists: () => true,
      livePreview: () => live,
      enter: () => false,
      indent: () => false,
    });
    e.keys("j");
    expect(e.cm.getCursor()).toMatchObject({ line: 1, ch: 4 });
    live = true;
    e.keys("dk");
    expect(e.cm.getValue()).toBe("123. abcdef");
    expect(Vim.getRegisterController().getRegister('"').toString()).toBe(
      "- abcdef\n- [ ] abcdef\n",
    );
  });

  it("retains the dollar goal and resets the relative goal after horizontal or external movement", () => {
    const e = editor("- abc\n- [ ] abcdef\n- abcdef", 0, {
      smartLists: () => true,
      livePreview: () => true,
      enter: () => false,
      indent: () => false,
    });
    e.keys("$j");
    expect(e.cm.getCursor()).toMatchObject({ line: 1, ch: 11 });
    e.keys("hj");
    expect(e.cm.getCursor()).toMatchObject({ line: 2, ch: 6 });
    e.cm.setCursor({ line: 0, ch: 2 });
    e.keys("j");
    expect(e.cm.getCursor()).toMatchObject({ line: 1, ch: 6 });
  });
  it.each([
    ["- [x] first", "osecond<Esc>", "- [x] first\n- [ ] second"],
    ["- first", "Ozero<Esc>", "- zero\n- first"],
    ["> ## Heading", "obody<Esc>", "> ## Heading\n> body"],
    ["## Heading", "obody<Esc>", "## Heading\nbody"],
    ["1. first\n2. next", "oadded<Esc>", "1. first\n2. added\n3. next"],
    ["9. first\n   child\n10. next", "Oadded<Esc>", "9. added\n10. first\n    child\n11. next"],
    ["- ", "o<Esc>", "- \n- "],
    ["- first\n  continuation", "jocontinued<Esc>", "- first\n  continuation\n  continued"],
  ])("edits %s with %s", (text, command, result) => {
    const e = editor(text);
    e.keys(command);
    expect(e.cm.getValue()).toBe(result);
    expect(e.cm.state.vim?.insertMode).toBe(false);
  });

  it.each([
    ["- [ ] abc", 8, "^", 6],
    ["> ## 本文", 6, "^", 5],
    ["> - [x] 😀e\u0301", 10, "^", 8],
  ])("moves to body start in %s", (text, at, command, end) => {
    const e = editor(text, at);
    e.keys(command);
    expect(e.cm.indexFromPos(e.cm.getCursor())).toBe(end);
  });

  it.each([
    ["d^", "- [ ] d"],
    ["c^X<Esc>", "- [ ] Xd"],
  ])("uses the same content start for %s", (command, result) => {
    const e = editor("- [ ] abcd", 9);
    e.keys(command);
    expect(e.cm.getValue()).toBe(result);
    expect(Vim.getRegisterController().getRegister('"').toString()).toBe("abc");
  });

  it("selects and yanks from the body start without the marker", () => {
    const e = editor("- [ ] abcd", 9);
    e.keys("v^y");
    expect(Vim.getRegisterController().getRegister('"').toString()).toBe("abcd");
    e.cm.setCursor({ line: 0, ch: 9 });
    e.keys("y^");
    expect(Vim.getRegisterController().getRegister('"').toString()).toBe("abc");
  });

  it("leaves an empty body unchanged for ^ and enters after its prefix for I", () => {
    const e = editor("- [ ] ", 0);
    e.keys("^");
    expect(e.cm.getCursor().ch).toBe(0);
    e.keys("c^");
    expect(e.cm.state.vim?.insertMode).toBe(false);
    expect(e.cm.getValue()).toBe("- [ ] ");
    e.keys("Itext<Esc>");
    expect(e.cm.getValue()).toBe("- [ ] text");
  });

  it.each([
    ["3oX<Esc>", "- first\n- X\n- X\n- X"],
    ["3OX<Esc>", "- X\n- X\n- X\n- first"],
    ["3IX<Esc>", "- XXXfirst"],
  ])("retains counted insertion for %s", (command, result) => {
    const e = editor("- first");
    e.keys(command);
    expect(e.cm.getValue()).toBe(result);
  });

  it("re-evaluates o on dot and macro replay in a different context", () => {
    const e = editor("- first\n> quote");
    e.keys("qaonew<Esc>q");
    expect(e.cm.getValue()).toBe("- first\n- new\n> quote");
    e.cm.setCursor({ line: 2, ch: 2 });
    e.keys("@a");
    expect(e.cm.getValue()).toBe("- first\n- new\n> quote\n> new");
    e.keys(".");
    expect(e.cm.getValue()).toBe("- first\n- new\n> quote\n> new\n> new");
  });

  it("falls back to the native action when replayed after disabling editing", () => {
    const e = editor("- first");
    e.keys("oX<Esc>");
    e.configure(false);
    e.keys(".");
    expect(e.cm.getValue()).toBe("- first\n- X\nX");
    e.keys("IY<Esc>");
    expect(e.cm.getValue()).toBe("- first\n- X\nYX");
  });

  it("preserves standard ^ inside code, frontmatter and tables", () => {
    for (const text of [
      "---\nkey: x\n---",
      "~~~\n- code\n~~~",
      "| a | b |\n| --- | --- |\n| - x | y |",
    ]) {
      const e = editor(text);
      e.cm.setCursor({ line: 1, ch: 3 });
      e.keys("^");
      expect(e.cm.getCursor().ch).toBe(0);
    }
  });

  it.each([
    ["    ", false, 0],
    ["~~~\n    \n~~~", true, 1],
  ] as const)("retains standard whitespace-only ^ ranges in %s", (text, enabled, line) => {
    const e = editor(text);
    e.configure(enabled);
    e.cm.setCursor({ line, ch: 1 });
    e.keys("^");
    expect(e.cm.getCursor()).toMatchObject({ line, ch: 3 });
    e.cm.setCursor({ line, ch: 1 });
    e.keys("d^");
    expect(e.cm.getLine(line)).toBe(" ");
  });

  it("restores a previous action delegate on cleanup", () => {
    const e = editor("- first");
    clearMarkdown(e.cm);
    const previous = { action: () => false };
    e.cm.state.lindvimeraTarget = previous;
    e.configure();
    expect(e.cm.state.lindvimeraTarget).not.toBe(previous);
    clearMarkdown(e.cm);
    expect(e.cm.state.lindvimeraTarget).toBe(previous);
  });
});
