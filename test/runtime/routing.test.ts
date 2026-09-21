import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history } from "@codemirror/commands";
import { getCM, Vim } from "@replit/codemirror-vim";
import { editorSession, lindvimeraEditor, type EditorHost } from "../../src/runtime/editor";
import { DEFAULT_SETTINGS } from "../../src/settings";

const cleanups: (() => void)[] = [];
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  document.elementFromPoint ??= () => null;
});
beforeEach(() => Vim.resetVimGlobalState_());
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function create(text = "alpha beta\ngamma delta", hooks: Partial<EditorHost> = {}) {
  const settings = { ...DEFAULT_SETTINGS, escapeSequences: [] as string[] };
  const hostEscape = vi.fn(() => false);
  const modeChanged = vi.fn();
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        // Reproduce Obsidian's existing keymap preceding our extension.
        keymap.of([{ key: "Escape", run: hostEscape, preventDefault: true }, ...defaultKeymap]),
        lindvimeraEditor({
          settings: () => settings,
          owner: () => undefined,
          modeChanged,
          ...hooks,
        }),
      ],
    }),
  });
  cleanups.push(() => view.destroy());
  view.focus();
  return {
    view,
    settings,
    cm: getCM(view)!,
    session: editorSession(view)!,
    hostEscape,
    modeChanged,
  };
}
function key(view: EditorView, value: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  view.contentDOM.dispatchEvent(event);
  if (
    !event.defaultPrevented &&
    value.length === 1 &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  )
    view.dispatch(view.state.replaceSelection(value), {
      annotations: Transaction.userEvent.of("input.type"),
    });
  return event;
}
function scope(view: EditorView, handler: (event: KeyboardEvent) => void) {
  const listener = (event: KeyboardEvent) => {
    const result = editorSession(view)!.routeKey(event);
    if (result !== "handled" && result !== "outside") handler(event);
  };
  window.addEventListener("keydown", listener, true);
  cleanups.push(() => window.removeEventListener("keydown", listener, true));
}

it.each([false, true])("Escape beats a preceding host keymap with scope=%s", (withScope) => {
  const { view, cm, hostEscape } = create();
  if (withScope) scope(view, () => {});
  key(view, "i");
  expect(cm.state.vim!.insertMode).toBe(true);
  key(view, "Escape");
  expect(cm.state.vim!.insertMode).toBe(false);
  expect(hostEscape).not.toHaveBeenCalled();
  key(view, "Escape");
  expect(hostEscape).not.toHaveBeenCalled();
});

it("suggestion cancellation takes one layer and never dispatches Escape twice", () => {
  let suggestion = true;
  const close = vi.fn(() => {
    suggestion = false;
    return true;
  });
  const { view, cm, hostEscape } = create("", {
    inputUI: () => (suggestion ? "suggestion" : "none"),
    cancelInputUI: close,
  });
  scope(view, () => {});
  key(view, "i");
  key(view, "Escape");
  expect(close).toHaveBeenCalledOnce();
  expect(cm.state.vim!.insertMode).toBe(true);
  key(view, "[", { ctrlKey: true });
  expect(cm.state.vim!.insertMode).toBe(false);
  expect(close).toHaveBeenCalledOnce();
  expect(hostEscape).not.toHaveBeenCalled();
});

it("declined shortcuts cancel all pending Vim input and run the host once", () => {
  const { view, cm } = create();
  const host = vi.fn();
  scope(view, (event) => {
    if (event.ctrlKey && event.altKey && event.key === "y") {
      host();
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });
  for (const value of '"a2d') key(view, value);
  key(view, "y", { ctrlKey: true, altKey: true });
  expect(host).toHaveBeenCalledOnce();
  key(view, "w");
  expect(view.state.doc.toString()).toBe("alpha beta\ngamma delta");
  expect(cm.getCursor()).toEqual({ line: 0, ch: 6 });
  expect(cm.state.vim!.inputState.registerName).toBeUndefined();
});

it("invalid printable continuations and Normal Enter cannot become native edits", () => {
  const { view } = create();
  key(view, "d");
  key(view, "~");
  key(view, "Enter");
  expect(view.state.doc.toString()).toBe("alpha beta\ngamma delta");
  const before = new InputEvent("beforeinput", {
    inputType: "insertText",
    data: "z",
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(before);
  expect(before.defaultPrevented).toBe(true);
});

it("a declined Insert key reaches native editing and its recorder only once", () => {
  const { view, cm } = create("");
  scope(view, () => {});
  key(view, "q");
  key(view, "a");
  key(view, "i");
  key(view, "x");
  key(view, "y");
  key(view, "Backspace");
  key(view, "Escape");
  key(view, "q");
  expect(view.state.doc.toString()).toBe("x");
  key(view, "@");
  key(view, "a");
  expect(view.state.doc.toString()).toBe("xx");
  expect(cm.state.vim!.insertMode).toBe(false);
});

it("Insert clipboard shortcuts and composing cancellation keep Insert active", () => {
  const { view, cm } = create();
  key(view, "i");
  view.dispatch({ selection: { anchor: 0, head: 3 } });
  expect(key(view, "c", { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(cm.state.vim!.insertMode).toBe(true);
  expect(key(view, "Escape", { isComposing: true }).defaultPrevented).toBe(false);
  expect(cm.state.vim!.insertMode).toBe(true);
});

it("flushes pending native DOM input before an immediate Escape", () => {
  const { view, cm } = create("");
  key(view, "i");
  view.contentDOM.dispatchEvent(
    new InputEvent("beforeinput", {
      inputType: "insertText",
      data: "abcjj",
      bubbles: true,
      cancelable: true,
    }),
  );
  const line = view.contentDOM.querySelector(".cm-line")!;
  line.textContent = "abcjj";
  window.getSelection()!.setBaseAndExtent(line.firstChild!, 5, line.firstChild!, 5);
  key(view, "Escape");
  expect(view.state.doc.toString()).toBe("abcjj");
  expect(Vim.getRegisterController().getRegister(".").toString()).toBe("abcjj");
  expect(cm.state.vim!.insertMode).toBe(false);
});

it("editor search controls and blocked overlay events do not execute Vim", () => {
  let blocked = false;
  const { view, cm } = create("abc", { inputUI: () => (blocked ? "blocked" : "none") });
  const input = document.createElement("input");
  view.dom.append(input);
  const event = new KeyboardEvent("keydown", { key: "i", bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(cm.state.vim!.insertMode).toBe(false);
  blocked = true;
  key(view, "x");
  expect(view.state.doc.toString()).toBe("abc");
});

it("status preserves Replace across refresh and shows pending input and recording", () => {
  const { view, session, modeChanged } = create();
  key(view, "R");
  session.configure();
  expect(modeChanged).toHaveBeenLastCalledWith("REPLACE");
  key(view, "Escape");
  key(view, "2");
  key(view, "d");
  expect(modeChanged.mock.lastCall?.[0]).toContain("2d");
  key(view, "Escape");
  key(view, "q");
  key(view, "a");
  expect(modeChanged.mock.lastCall?.[0]).toContain("recording @a");
});
