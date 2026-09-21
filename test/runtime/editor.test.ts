import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  defaultKeymap,
  deleteCharBackward,
  history,
  undo,
  redo,
  undoDepth,
} from "@codemirror/commands";
import { getCM, Vim } from "@replit/codemirror-vim";
import { editorSession, lindvimeraEditor } from "../../src/runtime/editor";
import { DEFAULT_SETTINGS } from "../../src/settings";
import type { JapaneseSegmenter } from "../../src/word";

const views: EditorView[] = [];
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
beforeEach(() => Vim.resetVimGlobalState_());
afterEach(() => {
  for (const view of views.splice(0)) {
    editorSession(view)?.flush();
    view.destroy();
  }
  vi.useRealTimers();
});
function create(text = "", wordSegmenter?: () => JapaneseSegmenter | undefined) {
  const settings = { ...DEFAULT_SETTINGS, escapeSequences: ["jj"] };
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        lindvimeraEditor({ settings: () => settings, owner: () => undefined, wordSegmenter }),
        keymap.of(defaultKeymap),
      ],
    }),
  });
  views.push(view);
  view.focus();
  return { view, settings };
}
function keys(view: EditorView, text: string) {
  for (const key of text.match(/<[^>]+>|./gu) ?? []) {
    const event = new KeyboardEvent("keydown", {
      key: key === "<Esc>" ? "Escape" : key === "<BS>" ? "Backspace" : key,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);
    if (!event.defaultPrevented && key.length === 1)
      view.dispatch(view.state.replaceSelection(key), {
        annotations: Transaction.userEvent.of("input.type"),
      });
    if (!event.defaultPrevented && key === "<BS>") deleteCharBackward(view);
  }
}
function preview(view: EditorView): string {
  return view.contentDOM.querySelector(".lindvimera-escape-preview")?.textContent ?? "";
}

function segmenter(id: string, width: number): JapaneseSegmenter {
  return {
    id,
    segment: vi.fn((text: string) =>
      Array.from({ length: Math.ceil(text.length / width) }, (_, index) => ({
        from: index * width,
        to: Math.min(text.length, (index + 1) * width),
      })),
    ),
  };
}
it("production input excludes jj from insert register, macro and dot even after configuration changes", () => {
  const { view, settings } = create();
  keys(view, "qaiabc");
  const historyBeforePreview = undoDepth(view.state);
  keys(view, "j");
  expect(preview(view)).toBe("j");
  expect(view.contentDOM.textContent).toBe("abcj");
  expect(view.state.doc.toString()).toBe("abc");
  expect(undoDepth(view.state)).toBe(historyBeforePreview);
  keys(view, "jq");
  expect(preview(view)).toBe("");
  expect(view.contentDOM.textContent).toBe("abc");
  expect(view.state.doc.toString()).toBe("abc");
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("abc");
  const recorded = Vim.getRegisterController().getRegister("a");
  expect(recorded.keyBuffer.join("")).not.toContain("jj");
  expect(recorded.insertModeChanges.flatMap((change) => change.changes)).toEqual(["a", "b", "c"]);
  expect(undoDepth(view.state)).toBe(historyBeforePreview);
  settings.escapeSequences = [];
  editorSession(view)!.configure();
  keys(view, "@a");
  expect(view.state.doc.toString()).toBe("ababcc");
  expect(getCM(view)!.state.vim!.insertMode).toBe(false);
  keys(view, ".");
  expect(view.state.doc.toString()).toBe("abababccc");
  expect(preview(view)).toBe("");
});
it("does not reinterpret a literal jj in dot replay or a macro", () => {
  const { view, settings } = create();
  settings.escapeSequences = [];
  editorSession(view)!.configure();
  keys(view, "qaAjj<Esc>q");
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("jj");
  settings.escapeSequences = ["jj"];
  editorSession(view)!.configure();
  keys(view, "@a");
  expect(view.state.doc.toString()).toBe("jjjj");
  keys(view, ".");
  expect(view.state.doc.toString()).toBe("jjjjjj");
  expect(getCM(view)!.state.vim!.insertMode).toBe(false);
});
it("production change and delayed input remain one undo event", () => {
  vi.useFakeTimers();
  const { view } = create("alpha beta");
  keys(view, "ciw");
  vi.advanceTimersByTime(60_000);
  keys(view, "new");
  vi.advanceTimersByTime(60_000);
  keys(view, " textjj");
  expect(view.state.doc.toString()).toBe("new text beta");
  expect(undoDepth(view.state)).toBe(1);
  undo(view);
  expect(view.state.doc.toString()).toBe("alpha beta");
  redo(view);
  expect(view.state.doc.toString()).toBe("new text beta");
});
it("keeps pending input in its original split pane", () => {
  const first = create().view;
  keys(first, "ij");
  expect(first.contentDOM.textContent).toBe("j");
  expect(first.state.doc.toString()).toBe("");
  const second = create().view;
  keys(second, "ixjj");
  expect(first.state.doc.toString()).toBe("j");
  expect(first.contentDOM.textContent).toBe("j");
  expect(preview(first)).toBe("");
  expect(second.state.doc.toString()).toBe("x");
  expect(preview(second)).toBe("");
});
it("passes native composition and pasted jj without running the escape matcher", () => {
  const { view } = create();
  keys(view, "i");
  const event = new KeyboardEvent("keydown", {
    key: "j",
    isComposing: true,
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  view.dispatch(view.state.replaceSelection("日本語jj"), {
    annotations: Transaction.userEvent.of("input.paste"),
  });
  expect(getCM(view)!.state.vim!.insertMode).toBe(true);
  keys(view, "<Esc>");
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("日本語jj");
});
it("updates feature settings without replacing the parent Vim session", () => {
  const { view, settings } = create("# first\ntext\n# next\n");
  const cm = getCM(view)!;
  keys(view, "]h");
  expect(cm.getCursor().line).toBe(2);
  settings.japanese = false;
  settings.markdownMotions = false;
  editorSession(view)!.configure();
  expect(getCM(view)).toBe(cm);
  expect(cm.state.wordBoundaryProvider).toBeDefined();
});
it("does not flush escape candidates or discard word cache on a settings-neutral refresh", () => {
  const { view } = create();
  keys(view, "ij");
  const provider = getCM(view)!.state.wordBoundaryProvider;
  editorSession(view)!.configure();
  expect(getCM(view)!.state.wordBoundaryProvider).toBe(provider);
  expect(view.state.doc.toString()).toBe("");
  expect(view.contentDOM.textContent).toBe("j");
  expect(preview(view)).toBe("j");
  keys(view, "j");
  expect(getCM(view)!.state.vim!.insertMode).toBe(false);
  expect(preview(view)).toBe("");
});

it("finishes an outstanding word operator before using a newly configured segmenter", async () => {
  const coarse = segmenter("coarse", 2);
  const fine = segmenter("fine", 1);
  let selected = coarse;
  const { view } = create("一二三四五六七八九十", () => selected);
  const cm = getCM(view)!;
  const initial = cm.state.wordBoundaryProvider;
  keys(view, "d");
  selected = fine;
  editorSession(view)!.configure();
  await Promise.resolve();
  expect(cm.state.wordBoundaryProvider).toBe(initial);
  keys(view, "w");
  expect(view.state.doc.toString()).toBe("三四五六七八九十");
  await Promise.resolve();
  expect(cm.state.wordBoundaryProvider).not.toBe(initial);
  keys(view, "w");
  expect(cm.getCursor().ch).toBe(1);
  expect(undoDepth(view.state)).toBe(1);
  undo(view);
  expect(view.state.doc.toString()).toBe("一二三四五六七八九十");
});

it.each([
  ["2", "w", 0, 4],
  ['"a', "yw", 0, 0],
  ["g", "e", 5, 3],
] as const)(
  "defers segmenter replacement during the %s prefix",
  async (prefix, command, at, end) => {
    let selected = segmenter("coarse", 2);
    const { view } = create("一二三四五六七八九十", () => selected);
    const cm = getCM(view)!;
    cm.setCursor({ line: 0, ch: at });
    const provider = cm.state.wordBoundaryProvider;
    keys(view, prefix);
    selected = segmenter("fine", 1);
    editorSession(view)!.configure();
    await Promise.resolve();
    expect(cm.state.wordBoundaryProvider).toBe(provider);
    keys(view, command);
    expect(cm.getCursor().ch).toBe(end);
    if (prefix === '"a')
      expect(Vim.getRegisterController().getRegister("a").toString()).toBe("一二");
    await Promise.resolve();
    expect(cm.state.wordBoundaryProvider).not.toBe(provider);
    keys(view, "w");
    expect(cm.getCursor().ch).toBe(end + 1);
  },
);

it("keeps Visual selection, registers and undo history while replacing only the provider", () => {
  let selected = segmenter("coarse", 2);
  const { view } = create("一二三四", () => selected);
  const cm = getCM(view)!;
  keys(view, "Axyjj");
  keys(view, '0"ayiwviw');
  const selection = view.state.selection;
  const vimState = cm.state.vim;
  const provider = cm.state.wordBoundaryProvider;
  const depth = undoDepth(view.state);
  expect(cm.getSelection()).toBe("一二");
  selected = segmenter("fine", 1);
  editorSession(view)!.configure();
  expect(getCM(view)).toBe(cm);
  expect(cm.state.vim).toBe(vimState);
  expect(cm.state.vim!.visualMode).toBe(true);
  expect(view.state.selection.eq(selection)).toBe(true);
  expect(cm.state.wordBoundaryProvider).not.toBe(provider);
  expect(Vim.getRegisterController().getRegister("a").toString()).toBe("一二");
  expect(undoDepth(view.state)).toBe(depth);
  keys(view, "<Esc>");
  undo(view);
  expect(view.state.doc.toString()).toBe("一二三四");
  redo(view);
  expect(view.state.doc.toString()).toBe("一二三四xy");
});

it("preserves an Insert edit and escape preview across a segmenter mode change", () => {
  let selected = segmenter("normal", 2);
  const { view } = create("", () => selected);
  keys(view, "iabcj");
  selected = segmenter("decompose", 1);
  editorSession(view)!.configure();
  expect(preview(view)).toBe("j");
  expect(getCM(view)!.state.vim!.insertMode).toBe(true);
  keys(view, "xjj");
  expect(view.state.doc.toString()).toBe("abcjx");
  expect(undoDepth(view.state)).toBe(1);
  undo(view);
  expect(view.state.doc.toString()).toBe("");
});

it("defers replacement through macro recording and applies it before the next command", async () => {
  let selected = segmenter("coarse", 2);
  const { view } = create("一二三四五六七八九十", () => selected);
  const cm = getCM(view)!;
  const provider = cm.state.wordBoundaryProvider;
  keys(view, "qa");
  selected = segmenter("fine", 1);
  editorSession(view)!.configure();
  await Promise.resolve();
  expect(cm.state.wordBoundaryProvider).toBe(provider);
  keys(view, "w");
  expect(cm.getCursor().ch).toBe(2);
  await Promise.resolve();
  expect(cm.state.wordBoundaryProvider).toBe(provider);
  keys(view, "qw");
  expect(cm.getCursor().ch).toBe(3);
  expect(cm.state.wordBoundaryProvider).not.toBe(provider);
  expect(Vim.getRegisterController().getRegister("a").keyBuffer.join("")).toBe("w");
});

it("retains one segmentation policy for an entire macro replay", async () => {
  let selected = segmenter("coarse", 2);
  const { view } = create("一二三四五六七八九十", () => selected);
  const cm = getCM(view)!;
  keys(view, "qawwq0");
  const provider = cm.state.wordBoundaryProvider;
  let changedDuringReplay = false;
  const change = () => {
    if (!Vim.getVimGlobalState_().macroModeState.isPlaying || changedDuringReplay) return;
    changedDuringReplay = true;
    selected = segmenter("fine", 1);
    editorSession(view)!.configure();
    expect(cm.state.wordBoundaryProvider).toBe(provider);
  };
  cm.on("vim-command-done", change);
  keys(view, "@a");
  cm.off("vim-command-done", change);
  expect(changedDuringReplay).toBe(true);
  expect(cm.getCursor().ch).toBe(4);
  await Promise.resolve();
  expect(cm.state.wordBoundaryProvider).not.toBe(provider);
  keys(view, "w");
  expect(cm.getCursor().ch).toBe(5);
});

it("rebuilds caches for a replacement instance with the same id and keeps NLP disabled when off", () => {
  let selected = segmenter("same-id", 2);
  const { view, settings } = create("一二三四五六", () => selected);
  const cm = getCM(view)!;
  keys(view, "w");
  expect(cm.getCursor().ch).toBe(2);
  const provider = cm.state.wordBoundaryProvider;
  selected = segmenter("same-id", 1);
  editorSession(view)!.configure();
  expect(cm.state.wordBoundaryProvider).not.toBe(provider);
  keys(view, "w");
  expect(cm.getCursor().ch).toBe(3);
  expect(selected.segment).toHaveBeenCalledOnce();
  settings.japanese = false;
  editorSession(view)!.configure();
  expect(cm.state.wordBoundaryProvider).toBeDefined();
  keys(view, "h");
  expect(cm.getCursor().ch).toBe(2);
  keys(view, "0e");
  expect(cm.getCursor().ch).toBe(5);
  expect(selected.segment).toHaveBeenCalledOnce();
});
it("flushes pending literals before directly destroying an editor", () => {
  const { view } = create();
  keys(view, "ij");
  expect(preview(view)).toBe("j");
  view.destroy();
  views.splice(views.indexOf(view), 1);
  expect(view.state.doc.toString()).toBe("j");
  expect(preview(view)).toBe("");
});

it("shows the first escape candidate synchronously without changing the document or history", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const { view } = create("before after");
  getCM(view)!.setCursor({ line: 0, ch: 7 });
  keys(view, "ij");
  // No timer advance or animation frame: the same keydown already changed the DOM.
  expect(view.contentDOM.textContent).toBe("before jafter");
  expect(preview(view)).toBe("j");
  expect(view.state.doc.toString()).toBe("before after");
  expect(undoDepth(view.state)).toBe(0);
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("");
  keys(view, "j");
  expect(view.contentDOM.textContent).toBe("before after");
  expect(view.state.doc.toString()).toBe("before after");
  expect(preview(view)).toBe("");
  expect(undoDepth(view.state)).toBe(0);
  vi.advanceTimersByTime(1000);
  expect(view.state.doc.toString()).toBe("before after");
});

it("commits a mismatched visible candidate once through the normal recorder", () => {
  const { view } = create();
  keys(view, "ij");
  expect(view.contentDOM.textContent).toBe("j");
  keys(view, "a");
  expect(preview(view)).toBe("");
  expect(view.contentDOM.textContent).toBe("ja");
  expect(view.state.doc.toString()).toBe("ja");
  keys(view, "jj");
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("ja");
  expect(undoDepth(view.state)).toBe(1);
  undo(view);
  expect(view.state.doc.toString()).toBe("");
  redo(view);
  expect(view.state.doc.toString()).toBe("ja");
});

it("keeps the same visible text when a candidate expires and does not duplicate it later", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const { view } = create();
  keys(view, "ij");
  expect(view.contentDOM.textContent).toBe("j");
  expect(view.state.doc.toString()).toBe("");
  vi.advanceTimersByTime(199);
  expect(preview(view)).toBe("j");
  expect(view.state.doc.toString()).toBe("");
  vi.advanceTimersByTime(1);
  expect(preview(view)).toBe("");
  expect(view.contentDOM.textContent).toBe("j");
  expect(view.state.doc.toString()).toBe("j");
  vi.advanceTimersByTime(1000);
  keys(view, "a<Esc>");
  expect(view.state.doc.toString()).toBe("ja");
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("ja");
});

it.each(["jjk", "jjl"])("shows a shared three-key prefix and removes it on %s", (sequence) => {
  const { view, settings } = create();
  settings.escapeSequences = ["jjk", "jjl"];
  editorSession(view)!.configure();
  keys(view, "ij");
  expect(preview(view)).toBe("j");
  keys(view, "j");
  expect(preview(view)).toBe("jj");
  expect(view.contentDOM.textContent).toBe("jj");
  expect(view.state.doc.toString()).toBe("");
  keys(view, sequence.at(-1)!);
  expect(preview(view)).toBe("");
  expect(view.contentDOM.textContent).toBe("");
  expect(view.state.doc.toString()).toBe("");
  expect(getCM(view)!.state.vim!.insertMode).toBe(false);
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("");
});

it("preserves visible overlap while committing only the unmatched prefix", () => {
  const { view, settings } = create();
  settings.escapeSequences = ["jk"];
  editorSession(view)!.configure();
  keys(view, "ijj");
  expect(view.state.doc.toString()).toBe("j");
  expect(preview(view)).toBe("j");
  expect(view.contentDOM.textContent).toBe("jj");
  keys(view, "k");
  expect(view.state.doc.toString()).toBe("j");
  expect(view.contentDOM.textContent).toBe("j");
  expect(preview(view)).toBe("");
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("j");
  expect(undoDepth(view.state)).toBe(1);
});

it("Backspace removes the visible candidate without leaving a stale preview", () => {
  const { view } = create();
  keys(view, "iabj");
  expect(view.contentDOM.textContent).toBe("abj");
  keys(view, "<BS>");
  expect(preview(view)).toBe("");
  expect(view.contentDOM.textContent).toBe("ab");
  expect(view.state.doc.toString()).toBe("ab");
  keys(view, "jj");
  expect(getCM(view)!.state.vim!.insertMode).toBe(false);
  keys(view, ".");
  expect(view.state.doc.toString()).toBe("aabb");
  expect(preview(view)).toBe("");
});

it("disabling escape keys commits the displayed candidate and removes its widget", () => {
  const { view, settings } = create();
  keys(view, "ij");
  expect(view.contentDOM.textContent).toBe("j");
  settings.escapeSequences = [];
  editorSession(view)!.configure();
  expect(preview(view)).toBe("");
  expect(view.contentDOM.textContent).toBe("j");
  expect(view.state.doc.toString()).toBe("j");
  keys(view, "j<Esc>");
  expect(view.state.doc.toString()).toBe("jj");
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("jj");
});

it("finishes a visible candidate before the plugin-disable path removes the engine", () => {
  const { view } = create();
  keys(view, "ij");
  expect(preview(view)).toBe("j");
  expect(undoDepth(view.state)).toBe(0);
  editorSession(view)!.finishInsert();
  expect(preview(view)).toBe("");
  expect(view.contentDOM.textContent).toBe("j");
  expect(view.state.doc.toString()).toBe("j");
  expect(getCM(view)!.state.vim!.insertMode).toBe(false);
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("j");
  expect(undoDepth(view.state)).toBe(1);
  undo(view);
  expect(view.state.doc.toString()).toBe("");
});

it("keeps a preview at its origin when the selection moves before the next key", () => {
  const { view } = create("ab");
  keys(view, "ij");
  expect(view.contentDOM.textContent).toBe("jab");
  expect(view.state.doc.toString()).toBe("ab");

  view.dispatch({ selection: { anchor: 2 } });
  expect(view.state.selection.main.head).toBe(2);
  expect(preview(view)).toBe("j");
  expect(view.contentDOM.textContent).toBe("jab");
  expect(view.state.doc.toString()).toBe("ab");

  keys(view, "x");
  expect(preview(view)).toBe("");
  expect(view.contentDOM.textContent).toBe("jabx");
  expect(view.state.doc.toString()).toBe("jabx");
  expect(view.state.selection.main.head).toBe(4);
  expect(getCM(view)!.state.vim!.insertMode).toBe(true);
  keys(view, "jj");
  expect(preview(view)).toBe("");
  expect(view.state.doc.toString()).toBe("jabx");
  expect(getCM(view)!.state.vim!.insertMode).toBe(false);
});

it("maps a pending candidate through an external insertion before committing it once", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const { view } = create("abcd");
  getCM(view)!.setCursor({ line: 0, ch: 2 });
  keys(view, "ij");
  expect(view.contentDOM.textContent).toBe("abjcd");
  expect(view.state.doc.toString()).toBe("abcd");

  view.dispatch({
    changes: { from: 0, insert: "X" },
    annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
  });
  expect(preview(view)).toBe("j");
  expect(view.contentDOM.textContent).toBe("Xabjcd");
  expect(view.state.doc.toString()).toBe("Xabcd");
  expect(view.state.selection.main.head).toBe(3);

  vi.advanceTimersByTime(200);
  expect(preview(view)).toBe("");
  expect(view.contentDOM.textContent).toBe("Xabjcd");
  expect(view.state.doc.toString()).toBe("Xabjcd");
  expect(view.state.selection.main.head).toBe(4);
  vi.advanceTimersByTime(1000);
  expect(view.contentDOM.textContent).toBe("Xabjcd");
  expect(view.state.doc.toString()).toBe("Xabjcd");
  keys(view, "<Esc>");
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("j");
});
