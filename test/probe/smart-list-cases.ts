import { Transaction } from "@codemirror/state";
import { foldable, foldEffect } from "@codemirror/language";
import { runScopeHandlers, type EditorView } from "@codemirror/view";
import type { Editor } from "obsidian";
import { getCM, Vim } from "./runtime";

const settle = () => new Promise<void>((resolve) => window.setTimeout(resolve, 180));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function physical(view: EditorView, sequence: string): void {
  for (const token of sequence.match(/<[^>]+>|./gu) ?? []) {
    const event = new KeyboardEvent("keydown", {
      key: token === "<Esc>" ? "Escape" : token === "<CR>" ? "Enter" : token,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);
    if (token.length === 1 && !event.defaultPrevented)
      view.dispatch(view.state.replaceSelection(token), { userEvent: "input.type" });
  }
}

/** Compare bundled editing to independent native commands in the real 1.15 host. */
export async function runSmartListCases(options: {
  view(): EditorView;
  editor(): Editor;
  source(value: boolean): Promise<void>;
  smart(value: boolean): void;
}): Promise<void> {
  const seed = async (text: string, at = 0, folded = false) => {
    const view = options.view();
    physical(view, "<Esc>");
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: at },
      annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
    });
    options.editor().exec("unfoldAll");
    view.focus();
    await settle();
    if (folded) {
      const range = foldable(view.state, 0, view.state.doc.line(1).to);
      assert(range, "Native list fixture did not expose a fold.");
      view.dispatch({ effects: foldEffect.of(range) });
    }
    return view;
  };
  for (const source of [true, false]) {
    await options.source(source);
    for (const smart of [true, false]) {
      options.smart(smart);
      await settle();
      for (const [text, folded] of [
        ["- [x] first\n- [ ] next", false],
        ["9. parent\n   - child\n10. next", false],
        ["> - [x] first\n> - [ ] next", false],
        ["- ", false],
        ["- parent\n  - child\n- next", true],
      ] as const) {
        let view = await seed(text, 0, folded);
        const firstEnd = view.state.doc.line(1).to;
        view.dispatch({ selection: { anchor: firstEnd } });
        assert(
          runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor"),
          "Native host did not handle Enter.",
        );
        await settle();
        const expected = view.state.doc.toString();
        const expectedCursor = view.state.selection.main.head;
        view = await seed(text, 0, folded);
        physical(view, "o");
        await settle();
        assert(
          view.state.doc.toString() === expected &&
            view.state.selection.main.head === expectedCursor,
          `o differs from native Enter (Source=${source}, Smart=${smart}, folded=${folded}): ${JSON.stringify(view.state.doc.toString())} vs ${JSON.stringify(expected)}`,
        );
        physical(view, "<Esc>u");
        assert(view.state.doc.toString() === text, "Native o was not a single undo operation.");
      }
      const text = "- parent\n  - child\n- next";
      for (const more of [true, false]) {
        let view = await seed(more ? text : "  - parent\n    - child\n- next");
        const initial = view.state.doc.toString();
        options.editor().exec(more ? "indentMore" : "indentLess");
        await settle();
        const expected = view.state.doc.toString();
        view = await seed(initial);
        physical(view, more ? ">>" : "<<");
        await settle();
        assert(
          view.state.doc.toString() === expected,
          `Indent differs from native exec (Source=${source}, Smart=${smart}): ${JSON.stringify(view.state.doc.toString())} vs ${JSON.stringify(expected)}`,
        );
        if (expected !== initial) {
          physical(view, "u");
          assert(
            view.state.doc.toString() === initial,
            "Native indentation was not one undo operation.",
          );
        }
      }
      const view = await seed("- first");
      physical(view, "A<CR>X<Esc>.");
      await settle();
      assert(
        view.state.doc.toString() === (smart ? "- first\n- X\n- X" : "- first\nX\nX"),
        `Insert Enter dot replay duplicated native changes (Smart=${smart}): ${JSON.stringify(view.state.doc.toString())}`,
      );
    }
    options.smart(true);
    await settle();
    let view = await seed("- first");
    physical(view, "3oX<Esc>");
    assert(
      view.state.doc.toString() === "- first\n- X\n- X\n- X",
      "Counted o lost native prefixes.",
    );
    physical(view, "u");
    assert(view.state.doc.toString() === "- first", "Counted o did not undo once.");
    view = await seed("9. [x] first\n10. next");
    // O has no native key binding. Its independent reference is the same insert-before
    // transaction through Obsidian's own CM6 surface; the host owns later normalization.
    view.dispatch({ changes: { from: 0, insert: "9. [ ] X\n" }, userEvent: "input" });
    await settle();
    const nativeAbove = view.state.doc.toString();
    view = await seed("9. [x] first\n10. next");
    physical(view, "OX<Esc>");
    await settle();
    assert(
      view.state.doc.toString() === nativeAbove && nativeAbove.startsWith("9. [ ] X\n"),
      `O did not preserve/reset prefixes and native numbering: ${JSON.stringify(view.state.doc.toString())}`,
    );
    view = await seed("- [x] abcdef", 9);
    physical(view, "^IX<Esc>");
    assert(view.state.doc.toString() === "- [x] Xabcdef", "^/I lost the Markdown content start.");
    view = await seed("9. firstabc\n10. [ ] taskbody\n11. surviving", 5);
    physical(view, "j");
    assert(
      getCM(view)!.getCursor().line === 1 && getCM(view)!.getCursor().ch === (source ? 5 : 10),
      `j used the wrong ${source ? "absolute" : "content-relative"} column: ${JSON.stringify(getCM(view)!.getCursor())}`,
    );
    physical(view, "dk");
    assert(
      Vim.getRegisterController().getRegister('"').toString() === "9. firstabc\n10. [ ] taskbody\n",
      "dk did not yank exactly the two physical source lines.",
    );
    assert(
      /^\d+\. surviving$/.test(view.state.doc.toString()),
      `dk did not preserve its physical-line operator range: ${JSON.stringify(view.state.doc.toString())}`,
    );
  }
}
