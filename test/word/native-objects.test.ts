import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { installWordProvider } from "../../src/word";
import fixtures from "./native-objects.json";

// Recorded with Neovim 0.12.5: nvim -n -u NONE -i NONE --headless.
// No native executable or generated/cache files are required to run these tests.
const matrix = (
  fixtures as [string, number, string, string, string | null, [number, number], string, string][]
).map(([source, offset, keys, text, selected, head, register, registerType]) => ({
  source,
  offset,
  keys,
  text,
  selected,
  head,
  register,
  registerType,
}));

const views: EditorView[] = [];
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
beforeEach(() => Vim.resetVimGlobalState_());
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("Neovim word object golden results", () => {
  it.each(matrix)("$keys at $offset in $source", (example) => {
    const view = new EditorView({
      state: EditorState.create({ doc: example.source, extensions: [vim()] }),
    });
    views.push(view);
    const cm = getCM(view)!;
    installWordProvider(cm);
    const line = view.state.doc.lineAt(example.offset);
    cm.setCursor({ line: line.number - 1, ch: example.offset - line.from });
    for (const key of example.keys) cm.operation(() => Vim.handleKey(cm, key, "user"));
    expect(view.state.doc.toString()).toBe(example.text);
    if (example.selected !== null) {
      expect(cm.getSelection()).toBe(example.selected);
      expect(cm.state.vim!.sel.head).toMatchObject({
        line: example.head[0] - 1,
        ch: example.head[1],
      });
    } else if (example.keys.startsWith("d")) {
      const register = Vim.getRegisterController().getRegister('"');
      expect(register.toString()).toBe(example.register);
      if (example.register) expect(!!register.linewise).toBe(example.registerType === "V");
    }
  });
});
