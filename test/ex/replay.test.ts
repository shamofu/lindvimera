import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, undo, undoDepth } from "@codemirror/commands";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import type { CodeMirrorV } from "@replit/codemirror-vim-core";
import { ExSession } from "../../src/ex/session";
import { installCommandPolicy } from "../../src/input/policy";
import { VimHistoryGroup } from "../../src/runtime/history";
import { PendingCommands } from "../../src/runtime/pending";
import { DEFAULT_SETTINGS, type KeyBinding } from "../../src/settings";

const cleanup: (() => void)[] = [];
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
beforeEach(() => Vim.resetVimGlobalState_());
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  document.body.replaceChildren();
});

function create(text = "one one") {
  const group = new VimHistoryGroup();
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: text, extensions: [history(), vim(), group.extension] }),
  });
  const cm = getCM(view)!;
  group.attach(cm);
  vi.spyOn(cm, "findPosV").mockImplementation((start, amount) => ({
    line: Math.max(cm.firstLine(), Math.min(cm.lastLine(), start.line + amount)),
    ch: start.ch,
  }));
  const errors: string[] = [];
  const pending = new PendingCommands(cm, group, (message) => errors.push(message));
  const ex = new ExSession(cm, {
    history: group,
    pending,
    error: (message) => errors.push(message),
  });
  const settings = { ...DEFAULT_SETTINGS, keyBindings: [] as KeyBinding[] };
  const removePolicy = installCommandPolicy(
    cm as CodeMirrorV,
    () => settings,
    (message) => errors.push(message),
  );
  const mappings: string[] = [];
  const keys = (sequence: string) => {
    for (const token of sequence.match(/<[^>]+>|./gu) ?? [])
      cm.operation(() => Vim.handleKey(cm, token, "user"));
  };
  cleanup.push(() => {
    removePolicy();
    ex.destroy();
    pending.destroy();
    group.destroy();
    view.destroy();
    for (const from of mappings) Vim.unmap(from, "normal");
  });
  return {
    cm,
    view,
    pending,
    errors,
    keys,
    reset(value = text) {
      keys("<Esc>");
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: 0 },
        annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
      });
      view.focus();
    },
    map(from: string, to: string) {
      settings.keyBindings = [...settings.keyBindings, { mode: "normal", from, to }];
      Vim.map(from, to, "normal");
      mappings.push(from);
    },
    command(command: string) {
      keys(":");
      const input = cm.state.dialog?.querySelector<HTMLInputElement>("input");
      expect(input).toBeTruthy();
      input!.value = command;
      input!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    async answer(key: string) {
      const input = cm.state.dialog?.querySelector<HTMLInputElement>("input");
      expect(input).toBeTruthy();
      input!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          keyCode: key === "Escape" ? 27 : key.toUpperCase().charCodeAt(0),
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

it("records a completed physical Ex prompt and replays the command once", () => {
  const f = create();
  f.keys("qa");
  f.command("%s/one/X/g");
  f.keys("q");
  expect(f.cm.getValue()).toBe("X X");
  f.reset();
  f.keys("@a");
  expect(f.cm.getValue()).toBe("X X");
  expect(f.cm.state.dialog).toBeFalsy();
  expect(f.errors).toEqual([]);
});

it("records Ex prompt blur as cancellation before later Normal macro keys", async () => {
  const f = create();
  f.view.focus();
  f.keys("qa");
  f.view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: ":",
      code: "Semicolon",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  const input = f.cm.state.dialog?.querySelector<HTMLInputElement>("input");
  expect(input).toBeTruthy();
  input!.value = "delete";
  input!.blur();
  f.view.focus();
  await vi.waitFor(() => expect(f.cm.state.dialog).toBeFalsy());
  f.keys("xq");
  expect(f.cm.getValue()).toBe("ne one");
  f.reset();
  f.keys("@a");
  expect(f.cm.getValue()).toBe("ne one");
  expect(f.cm.state.dialog).toBeFalsy();
  expect(f.cm.state.vim?.insertMode).toBe(false);
  expect(f.errors).toEqual([]);
});

it("records Visual Ex ranges without duplicating the automatic Visual prefix", () => {
  const f = create("one\none\nlast");
  f.keys("qaVj");
  f.command("'<,'>s/one/X/g");
  f.keys("q");
  expect(f.cm.getValue()).toBe("X\nX\nlast");
  f.reset();
  const parsed = vi.spyOn(f.cm.state.exCommandProvider!, "parse");
  f.keys("@a");
  expect(
    f.cm.getValue(),
    JSON.stringify({
      errors: f.errors,
      parsed: parsed.mock.calls.map((args) => args[0]),
      macro: Vim.getRegisterController().getRegister("a").keyBuffer,
    }),
  ).toBe("X\nX\nlast");
  expect(f.errors).toEqual([]);
});

it("records a mapping that invokes Ex without recording its prompt a second time", () => {
  const f = create("one");
  f.map("Q", ":s/one/oneX/<CR>");
  f.keys("qaQq");
  expect(f.cm.getValue()).toBe("oneX");
  f.reset();
  f.keys("@a");
  expect(f.cm.getValue()).toBe("oneX");
  expect(f.errors).toEqual([]);
});

it.each(["mapping", "macro"])(
  "edits a nonempty virtual Ex prompt with Backspace in a %s",
  (replay) => {
    const f = create();
    const command = ":d<BS>y<CR>";
    if (replay === "mapping") {
      f.map("Q", command);
      f.keys("Q");
    } else {
      Vim.getRegisterController().getRegister("a").setText(command);
      f.keys("@a");
    }
    expect(f.cm.getValue()).toBe("one one");
    expect(Vim.getRegisterController().getRegister().toString()).toBe("one one\n");
    expect(undoDepth(f.view.state)).toBe(0);
    expect(f.cm.state.dialog).toBeFalsy();
    expect(f.errors).toEqual([]);
  },
);

it.each(["mapping", "macro"])(
  "removes a complete code point with virtual prompt Backspace in a %s",
  (replay) => {
    const f = create();
    const command = ":%s/one/😀<BS>X/g<CR>";
    if (replay === "mapping") {
      f.map("Q", command);
      f.keys("Q");
    } else {
      Vim.getRegisterController().getRegister("a").setText(command);
      f.keys("@a");
    }
    expect(f.cm.getValue()).toBe("X X");
    expect(f.cm.state.dialog).toBeFalsy();
    expect(f.errors).toEqual([]);
  },
);

it("cancels an empty virtual Ex prompt with Backspace before Normal and Insert keys", () => {
  const f = create();
  f.map("Q", ":<BS>sfoo<Esc>");
  f.keys("Q");
  expect(f.cm.getValue()).toBe("foone one");
  expect(f.cm.state.vim?.insertMode).toBe(false);
  expect(f.cm.state.dialog).toBeFalsy();
  expect(undoDepth(f.view.state)).toBe(1);
  expect(f.errors).toEqual([]);
});

it.each(["raw macro", "mapping", "last Ex"])(
  "pauses a %s until confirmation and then resumes its suffix",
  async (replay) => {
    const f = create();
    const command = ":%s/one/X/gc<CR>gg0rZ";
    if (replay === "raw macro") {
      Vim.getRegisterController().getRegister("a").setText(command);
      f.keys("@a");
    } else if (replay === "mapping") {
      f.map("Q", command);
      f.keys("Q");
    } else {
      f.command("%s/one/X/gc");
      await f.answer("a");
      f.reset();
      Vim.getRegisterController().getRegister("a").setText("@:gg0rZ");
      f.keys("@a");
    }
    expect(f.pending.pending).toBe(true);
    expect(f.cm.getValue()).toBe("one one");
    await f.answer("a");
    expect(f.pending.pending).toBe(false);
    expect(f.cm.getValue()).toBe("Z X");
    expect(f.cm.state.dialog).toBeFalsy();
    expect(undo(f.view)).toBe(true);
    expect(f.cm.getValue()).toBe("one one");
    expect(redo(f.view)).toBe(true);
    expect(f.cm.getValue()).toBe("Z X");
    expect(f.errors).toEqual([]);
  },
);

it("keeps two confirmations ahead of the outer mapping suffix and in one Undo", async () => {
  const f = create();
  f.map("Z", ":%s/one/two/gc<CR>:%s/two/X/gc<CR>");
  f.map("Q", "Zgg0rZ");
  f.keys("Q");
  expect(f.cm.getValue()).toBe("one one");
  await f.answer("a");
  expect(f.cm.getValue()).toBe("two two");
  expect(f.pending.pending).toBe(true);
  await f.answer("a");
  expect(f.cm.getValue()).toBe("Z X");
  expect(f.pending.pending).toBe(false);
  expect(undoDepth(f.view.state)).toBe(1);
  undo(f.view);
  expect(f.cm.getValue()).toBe("one one");
});

it.each(["q", "Escape"])(
  "keeps accepted replacements and resumes after confirmation %s",
  async (cancel) => {
    const f = create("one one one");
    f.map("Q", ":%s/one/X/gc<CR>gg0rZ");
    f.keys("Q");
    await f.answer("y");
    await f.answer(cancel);
    expect(f.cm.getValue()).toBe("Z one one");
    expect(f.pending.pending).toBe(false);
    expect(undoDepth(f.view.state)).toBe(1);
    undo(f.view);
    expect(f.cm.getValue()).toBe("one one one");
  },
);

it.each([":set number<CR>rZ", ":%s/one/X/z<CR>rZ"])(
  "stops rejected raw Ex macro %s before its editing suffix",
  (macro) => {
    const f = create();
    Vim.getRegisterController().getRegister("a").setText(macro);
    f.keys("@a");
    expect(f.cm.getValue()).toBe("one one");
    expect(undoDepth(f.view.state)).toBe(0);
    expect(f.errors.length).toBeGreaterThan(0);
    expect(f.pending.pending).toBe(false);
  },
);

it.each([":set number<CR>rZ", ":%s/one/X/z<CR>rZ"])(
  "stops invalid mapped Ex %s before its editing suffix",
  (mapping) => {
    const f = create();
    f.map("Q", mapping);
    const policy = f.cm.state.commandPolicy!;
    const allows = policy.allows;
    // Bypass only saved-mapping validation to exercise rejection during replay,
    // as when an already queued mapping becomes invalid before it resumes.
    policy.allows = (command, context, keys) =>
      command.type === "keyToKey" && command.keys === "Q" ? true : allows(command, context, keys);
    f.keys("Q");
    expect(f.cm.getValue()).toBe("one one");
    expect(undoDepth(f.view.state)).toBe(0);
    expect(f.errors.length).toBeGreaterThan(0);
    expect(f.pending.pending).toBe(false);
  },
);
