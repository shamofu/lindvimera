import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  cursorCharLeft,
  defaultKeymap,
  history,
  redo,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { VimHistoryGroup } from "../../src/runtime/history";
import { escapePreview, showEscapePreview } from "../../src/input/escape-preview";

const disposables: (() => void)[] = [];
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  for (const dispose of disposables.splice(0)) dispose();
  vi.useRealTimers();
});

function create(text: string) {
  Vim.resetVimGlobalState_();
  const group = new VimHistoryGroup();
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      extensions: [history(), vim(), group.extension, escapePreview, keymap.of(defaultKeymap)],
    }),
  });
  const cm = getCM(view)!;
  group.attach(cm);
  disposables.push(() => {
    group.destroy();
    view.destroy();
  });
  const keys = (text: string) => {
    for (const key of text.match(/<[^>]+>|./g) ?? [])
      cm.operation(() => Vim.handleKey(cm, key, "user"));
  };
  const insert = (text: string) =>
    view.dispatch(view.state.replaceSelection(text), {
      annotations: Transaction.userEvent.of("input.type"),
    });
  return { view, keys, insert };
}

it("groups change plus its entire Insert tail across long pauses into one Undo/Redo", () => {
  vi.useFakeTimers();
  const { view, keys, insert } = create("alpha beta");
  keys("ciw");
  vi.advanceTimersByTime(60_000);
  insert("new");
  vi.advanceTimersByTime(60_000);
  insert(" text");
  keys("<Esc>");
  expect(view.state.doc.toString()).toBe("new text beta");
  expect(undoDepth(view.state)).toBe(1);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("alpha beta");
  expect(redo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("new text beta");
});

it("keeps consecutive Vim commands separate even without time passing", () => {
  const { view, keys } = create("abcd");
  keys("xx");
  expect(view.state.doc.toString()).toBe("cd");
  expect(undoDepth(view.state)).toBe(2);
  undo(view);
  expect(view.state.doc.toString()).toBe("bcd");
});

it("isolates independent insert sessions and replay edits", () => {
  const { view, keys, insert } = create("");
  keys("i");
  insert("abc");
  keys("<Esc>");
  keys("A");
  insert("def");
  keys("<Esc>");
  expect(undoDepth(view.state)).toBe(2);
  undo(view);
  expect(view.state.doc.toString()).toBe("abc");
  redo(view);
  keys(".");
  expect(view.state.doc.toString()).toBe("abcdefdef");
  expect(undoDepth(view.state)).toBe(3);
});
it("isolates unannotated external transactions from an open Insert group", () => {
  const { view, keys, insert } = create("");
  keys("i");
  insert("local");
  view.dispatch({ changes: { from: 5, insert: " external" } });
  insert("next");
  keys("<Esc>");
  undo(view);
  expect(view.state.doc.toString()).toBe("local external");
  undo(view);
  expect(view.state.doc.toString()).toBe("local");
});

it.each(["arrow", "pointer"])("splits Insert Undo after a %s move and preserves Redo", (move) => {
  const { view, keys, insert } = create("");
  keys("i");
  insert("abc");
  if (move === "arrow") cursorCharLeft(view);
  else view.dispatch({ selection: { anchor: 2 }, userEvent: "select.pointer" });
  insert("X");
  keys("<Esc>");
  expect(view.state.doc.toString()).toBe("abXc");
  expect(undoDepth(view.state)).toBe(2);
  undo(view);
  expect(view.state.doc.toString()).toBe("abc");
  undo(view);
  expect(view.state.doc.toString()).toBe("");
  redo(view);
  expect(view.state.doc.toString()).toBe("abc");
  redo(view);
  expect(view.state.doc.toString()).toBe("abXc");
});

it("ignores a no-op selection, preview rendering and host cursor restoration", () => {
  const { view, keys, insert } = create("");
  keys("i");
  insert("abc");
  view.dispatch({ selection: { anchor: 3 }, userEvent: "select" });
  showEscapePreview(view, "j");
  showEscapePreview(view, "");
  view.dispatch({ selection: { anchor: 2 } });
  insert("X");
  keys("<Esc>");
  expect(view.state.doc.toString()).toBe("abXc");
  expect(undoDepth(view.state)).toBe(1);
  undo(view);
  expect(view.state.doc.toString()).toBe("");
});

it("keeps IME selection updates inside the active Insert edit", () => {
  const { view, keys, insert } = create("");
  keys("i");
  insert("あい");
  const composing = vi.spyOn(view, "composing", "get").mockReturnValue(true);
  view.dispatch({ selection: { anchor: 1, head: 2 }, userEvent: "select" });
  view.dispatch(view.state.replaceSelection("う"), { userEvent: "input.type.compose" });
  composing.mockRestore();
  keys("<Esc>");
  expect(view.state.doc.toString()).toBe("あう");
  expect(undoDepth(view.state)).toBe(1);
  undo(view);
  expect(view.state.doc.toString()).toBe("");
});

it("keeps recorded Insert navigation in one group during macro replay", () => {
  const { view, keys, insert } = create("");
  keys("qai");
  insert("abc");
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  insert("X");
  keys("<Esc>q");
  expect(view.state.doc.toString()).toBe("abXc");
  expect(undoDepth(view.state)).toBe(2);
  keys("$@a");
  const replayed = view.state.doc.toString();
  expect(replayed).not.toBe("abXc");
  expect(undoDepth(view.state)).toBe(3);
  undo(view);
  expect(view.state.doc.toString()).toBe("abXc");
  redo(view);
  expect(view.state.doc.toString()).toBe(replayed);
});
