import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, undo, undoDepth } from "@codemirror/commands";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { PendingCommands } from "../../src/runtime/pending";
import { VimHistoryGroup } from "../../src/runtime/history";

const cleanup: (() => void)[] = [];
let fixtureNumber = 0;
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
beforeEach(() => Vim.resetVimGlobalState_());
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  document.body.replaceChildren();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject, cancel: vi.fn() };
}

function create(text = "abcdefghijklmno") {
  const fixture = ++fixtureNumber;
  const group = new VimHistoryGroup();
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: text, extensions: [history(), vim(), group.extension] }),
  });
  const cm = getCM(view)!;
  group.attach(cm);
  const errors: string[] = [];
  const pending = new PendingCommands(cm, group, (message) => errors.push(message));
  const waits: ReturnType<typeof deferred>[] = [];
  const events: string[] = [];
  const mappings: string[] = [];
  const action = (key: string, name: string, run: () => void) => {
    name += fixture;
    Vim.defineAction(name, run);
    Vim.mapCommand(
      key,
      "action",
      name,
      {},
      { context: "normal", when: (candidate: unknown) => candidate === cm },
    );
    mappings.push(key);
  };
  action("<F5>", "testPendingSuspend", () => {
    const task = deferred();
    waits.push(task);
    events.push(`wait:${waits.length}`);
    pending.waitFor(task.promise, task.cancel);
  });
  action("<F6>", "testPendingInner", () => events.push("inner"));
  action("<F7>", "testPendingMacro", () => events.push("macro"));
  action("<F8>", "testPendingOuter", () => events.push("outer"));
  cleanup.push(() => {
    pending.destroy();
    group.destroy();
    view.destroy();
    for (const key of mappings) Vim.unmap(key, "normal");
  });
  return {
    view,
    cm,
    pending,
    waits,
    errors,
    events,
    keys(sequence: string) {
      for (const key of sequence.match(/<[^>]+>|./gu) ?? [])
        cm.operation(() => Vim.handleKey(cm, key, "user"));
    },
    map(from: string, to: string) {
      Vim.map(from, to, "normal");
      mappings.push(from);
    },
    async complete(index: number) {
      waits[index].resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

it("resumes an inner mapping before its macro, counted macro, and outer mapping", async () => {
  const f = create();
  f.map("Z", "<F5><F6>");
  Vim.getRegisterController().getRegister("a").setText("Z<F7>");
  f.map("Q", "2@a<F8>");
  f.keys("Q");
  expect(f.events).toEqual(["wait:1"]);
  expect(f.pending.pending).toBe(true);
  expect(Vim.getVimGlobalState_().macroModeState.isPlaying).toBe(false);
  await f.complete(0);
  expect(f.events).toEqual(["wait:1", "inner", "macro", "wait:2"]);
  expect(f.pending.pending).toBe(true);
  await f.complete(1);
  expect(f.events).toEqual(["wait:1", "inner", "macro", "wait:2", "inner", "macro", "outer"]);
  expect(f.pending.pending).toBe(false);
  expect(Vim.getVimGlobalState_().macroModeState.isPlaying).toBe(false);
  expect(f.errors).toEqual([]);
});

it("keeps a second inner wait ahead of already queued macro and mapping callers", async () => {
  const f = create();
  f.map("Z", "<F5><F6><F5><F6>");
  Vim.getRegisterController().getRegister("a").setText("Z<F7>");
  f.map("Q", "@a<F8>");
  f.keys("Q");
  await f.complete(0);
  expect(f.events).toEqual(["wait:1", "inner", "wait:2"]);
  await f.complete(1);
  expect(f.events).toEqual(["wait:1", "inner", "wait:2", "inner", "macro", "outer"]);
  expect(f.pending.pending).toBe(false);
});

it("cancels the whole suspended suffix and ignores late task completion", async () => {
  const f = create();
  f.map("Z", "x<F5>x<F6>");
  Vim.getRegisterController().getRegister("a").setText("Z<F7>");
  f.map("Q", "2@a<F8>");
  f.keys("Q");
  expect(f.cm.getValue()).toBe("bcdefghijklmno");
  f.pending.cancel();
  expect(f.waits[0].cancel).toHaveBeenCalledOnce();
  await f.complete(0);
  expect(f.events).toEqual(["wait:1"]);
  expect(f.cm.getValue()).toBe("bcdefghijklmno");
  expect(f.pending.pending).toBe(false);
  expect(Vim.getVimGlobalState_().macroModeState.isPlaying).toBe(false);
  expect(undo(f.view)).toBe(true);
  expect(f.cm.getValue()).toBe("abcdefghijklmno");
});

it("reports a failed wait once and stops all queued suffixes", async () => {
  const f = create();
  f.map("Q", "x<F5>x<F8>");
  f.keys("Q");
  f.waits[0].reject(new Error("Destination was removed"));
  await Promise.resolve();
  await Promise.resolve();
  expect(f.events).toEqual(["wait:1"]);
  expect(f.errors).toEqual(["Destination was removed"]);
  expect(f.cm.getValue()).toBe("bcdefghijklmno");
  expect(f.pending.pending).toBe(false);
  expect(f.waits[0].cancel).toHaveBeenCalledOnce();
  f.keys("x");
  expect(f.cm.getValue()).toBe("cdefghijklmno");
  expect(undoDepth(f.view.state)).toBe(2);
});

it("keeps edits on both sides of asynchronous waits in one Undo and Redo", async () => {
  const f = create();
  f.map("Z", "x<F5>x<F5>x");
  f.map("Q", "Zx");
  f.keys("Q");
  expect(f.cm.getValue()).toBe("bcdefghijklmno");
  await f.complete(0);
  expect(f.cm.getValue()).toBe("cdefghijklmno");
  await f.complete(1);
  expect(f.cm.getValue()).toBe("efghijklmno");
  expect(undoDepth(f.view.state)).toBe(1);
  expect(undo(f.view)).toBe(true);
  expect(f.cm.getValue()).toBe("abcdefghijklmno");
  expect(redo(f.view)).toBe(true);
  expect(f.cm.getValue()).toBe("efghijklmno");
});

it("does not let a cancelled generation release a newer pending command", async () => {
  const f = create();
  f.map("Q", "<F5><F8>");
  f.keys("Q");
  f.pending.cancel();
  f.keys("Q");
  expect(f.events).toEqual(["wait:1", "wait:2"]);
  await f.complete(0);
  expect(f.pending.pending).toBe(true);
  expect(f.events).toEqual(["wait:1", "wait:2"]);
  await f.complete(1);
  expect(f.pending.pending).toBe(false);
  expect(f.events).toEqual(["wait:1", "wait:2", "outer"]);
});

it("destroy cancels pending replay and removes its continuation hook", async () => {
  const f = create();
  f.map("Q", "<F5><F8>");
  f.keys("Q");
  f.pending.destroy();
  await f.complete(0);
  expect(f.cm.state.commandContinuation).toBeUndefined();
  expect(f.events).toEqual(["wait:1"]);
  expect(f.waits[0].cancel).toHaveBeenCalledOnce();
});

it("clears a pending operator when the final dequeued continuation throws", async () => {
  const f = create();
  f.cm.state.commandPolicy = {
    allows: () => true,
    allowsReplay: () => true,
    onRejected: () => {},
  };
  f.keys("<F5>");
  f.pending.defer(() => {
    f.keys("d");
    expect(f.cm.state.vim?.inputState.operator).toBe("delete");
    throw new Error("Final continuation failed");
  });
  await f.complete(0);
  expect(f.pending.pending).toBe(false);
  expect(f.cm.state.vim?.inputState.operator).toBeFalsy();
  expect(f.cm.state.commandPolicy.rejected).toBe(true);
  expect(f.errors).toEqual(["Final continuation failed"]);
  expect(f.cm.getValue()).toBe("abcdefghijklmno");
  f.keys("xx");
  expect(undoDepth(f.view.state)).toBe(2);
});

it("releases history and clears input even when the task cancellation callback throws", async () => {
  const f = create();
  f.cm.state.commandPolicy = {
    allows: () => true,
    allowsReplay: () => true,
    onRejected: () => {},
  };
  f.keys("x<F5>d");
  f.pending.defer(() => f.events.push("unexpected suffix"));
  f.waits[0].cancel.mockImplementation(() => {
    throw new Error("Cancellation callback failed");
  });
  try {
    f.pending.cancel();
  } catch (reason) {
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe("Cancellation callback failed");
  }
  expect(f.pending.pending).toBe(false);
  expect(f.cm.state.vim?.inputState.operator).toBeFalsy();
  expect(f.cm.state.commandPolicy.rejected).toBe(true);
  expect(f.waits[0].cancel).toHaveBeenCalledOnce();
  await f.complete(0);
  expect(f.events).toEqual(["wait:1"]);
  f.keys("xx");
  expect(f.cm.getValue()).toBe("defghijklmno");
  expect(undoDepth(f.view.state)).toBe(3);
});

it("keeps a suspended macro's search state out of another editor's prompt", async () => {
  const a = create();
  const b = create("alpha beta alpha");
  const macro = Vim.getRegisterController().getRegister("a");
  macro.setText("x<F5>x");
  macro.searchQueries.push("alpha");
  a.keys("@a");
  expect(a.pending.pending).toBe(true);
  expect(a.cm.getValue()).toBe("bcdefghijklmno");
  expect(Vim.getVimGlobalState_().macroModeState.isPlaying).toBe(false);
  b.keys("/");
  const input = b.view.dom.querySelector<HTMLInputElement>(".cm-vim-panel input");
  expect(input).not.toBeNull();
  expect(b.cm.getCursor().ch).toBe(0);
  input!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true }),
  );
  await a.complete(0);
  expect(a.cm.getValue()).toBe("cdefghijklmno");
  expect(b.cm.getValue()).toBe("alpha beta alpha");
  expect(a.errors).toEqual([]);
});

it("records another editor's native Insert for dot and macros while a macro waits", async () => {
  const a = create();
  const b = create("tail");
  Vim.getRegisterController().getRegister("a").setText("x<F5>x");
  a.keys("@a");
  b.keys("i");
  b.view.dispatch(b.view.state.replaceSelection("B"), {
    annotations: Transaction.userEvent.of("input.type"),
  });
  b.keys("<Esc>.");
  expect(b.cm.getValue()).toBe("BBtail");
  b.keys("qbA");
  // The Insert text is the browser's own transaction, as in an active Obsidian pane.
  b.view.dispatch(b.view.state.replaceSelection("K"), {
    annotations: Transaction.userEvent.of("input.type"),
  });
  b.keys("<Esc>q");
  expect(Vim.getRegisterController().getRegister("b").insertModeChanges).toHaveLength(1);
  b.keys("@b");
  expect(b.cm.getValue()).toBe("BBtailKK");
  expect(a.cm.getValue()).toBe("bcdefghijklmno");
  await a.complete(0);
  expect(a.cm.getValue()).toBe("cdefghijklmno");
  expect(b.cm.getValue()).toBe("BBtailKK");
  expect(Vim.getVimGlobalState_().macroModeState.isPlaying).toBe(false);
});
