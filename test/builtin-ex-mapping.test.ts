import { afterEach, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import {
  NativeCommandQueue,
  NativeExBridge,
  nativeReplacementInput,
} from "../src/engines/builtin/ex-mapping";
import type { NativeArgs, NativeCM, NativeVim } from "../src/engines/builtin/native";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
  vi.useRealTimers();
});
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

it("preserves JS replacement tokens while escaping only the native replacement preprocessing", () => {
  expect(nativeReplacementInput("%s/(a)(b)/$$-$&-$2$1-$99/g")).toBe("%s/(a)(b)/$$-$\\&-$2$1-$99/g");
  expect(nativeReplacementInput("s/foo/&-\\1/g")).toBe("s/foo/\\&-\\\\1/g");
  expect(nativeReplacementInput("s/foo//gc")).toBe("s/foo//gc");
  expect(nativeReplacementInput("set number")).toBe("set number");
  expect(nativeReplacementInput("s/(a)(b)/$2$1-$&-$$-$99/g", false)).toBe(
    "s/(a)(b)/\\2\\1-\\0-$-\\99/g",
  );
});

it("serializes pending native commands and resumes against a recreated cell", async () => {
  const calls: string[] = [];
  let target = { id: "old" } as unknown as NativeCM;
  let finish!: () => void;
  const queue = new NativeCommandQueue({
    liveTargetCM: () => target,
    isActive: () => true,
    dispatch: (cm, key) => {
      calls.push(`${(cm as unknown as { id: string }).id}:${key}`);
      return true;
    },
  });
  queue.waitFor(
    new Promise((resolve) => {
      finish = resolve;
    }),
    () => {},
  );
  const first = queue.intercept(target, "j", "macro");
  const second = queue.intercept(target, "k", "macro");
  if (first) first();
  if (second) second();
  expect(calls).toEqual([]);
  target = { id: "new" } as unknown as NativeCM;
  finish();
  await tick();
  expect(calls).toEqual(["new:j", "new:k"]);
  queue.dispose();
});

it("cancels a never-resolving native task and discards its queued macro keys", async () => {
  const dispatch = vi.fn();
  const cancel = vi.fn();
  const cm = {} as NativeCM;
  const queue = new NativeCommandQueue({ liveTargetCM: () => cm, isActive: () => true, dispatch });
  queue.waitFor(new Promise(() => {}), cancel);
  const next = queue.intercept(cm, "j", "macro");
  if (next) next();
  const escape = queue.intercept(cm, "<Esc>");
  expect(escape && escape()).toBe(true);
  await queue.settled();
  expect(cancel).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
  queue.dispose();
});

it("places a suspended native macro continuation after its RHS and before the outer tail", async () => {
  const calls: string[] = [];
  const cm = {} as NativeCM;
  const queue = new NativeCommandQueue({
    liveTargetCM: () => cm,
    isActive: () => true,
    dispatch(_cm, key) {
      calls.push(key);
      if (key === "X")
        queue.withNativeFrame(
          () => {
            queue.run("Q");
          },
          () => ({
            run: () => {
              calls.push("continuation");
            },
          }),
        );
      return true;
    },
  });
  queue.run("Xz");
  await tick();
  expect(calls).toEqual(["X", "Q", "continuation", "z"]);
  queue.dispose();
});

it("bounds nested native frames inside out and resumes them in that order", async () => {
  const calls: string[] = [];
  const stops: string[] = [];
  const cm = {} as NativeCM;
  const queue = new NativeCommandQueue({
    liveTargetCM: () => cm,
    isActive: () => true,
    dispatch(_cm, key) {
      calls.push(key);
      if (key === "X")
        queue.withNativeFrame(
          () => {
            expect(queue.intercept(cm, "i", "macro")).toBe(false);
            queue.withNativeFrame(
              () => {
                queue.run("Q");
              },
              () => {
                stops.push("inner");
                return {
                  run: () => {
                    calls.push("inner");
                  },
                };
              },
            );
          },
          () => {
            stops.push("outer");
            return {
              run: () => {
                calls.push("outer");
              },
            };
          },
        );
      return true;
    },
  });
  queue.run("Xz");
  await tick();
  expect(stops).toEqual(["inner", "outer"]);
  expect(calls).toEqual(["X", "Q", "inner", "outer", "z"]);
  queue.dispose();
});

it("keeps a native command's synchronous alias suffix ahead of its replay continuation", async () => {
  const calls: string[] = [];
  const cm = {} as NativeCM;
  const queue = new NativeCommandQueue({
    liveTargetCM: () => cm,
    isActive: () => true,
    dispatch(_cm, key) {
      calls.push(key);
      if (key === "X")
        queue.withNativeFrame(
          () => {
            queue.run("Q");
            const suffix = queue.intercept(cm, "j", "mapping");
            if (suffix) suffix();
            else calls.push("overtook");
          },
          () => ({
            run: () => {
              calls.push("continuation");
            },
          }),
        );
      return true;
    },
  });
  queue.run("Xz");
  await tick();
  expect(calls).toEqual(["X", "Q", "j", "continuation", "z"]);
  queue.dispose();
});

it("resumes a native wait continuation on the current target before the outer tail", async () => {
  const calls: string[] = [];
  let target = { id: "old" } as unknown as NativeCM;
  let resolve!: () => void;
  const queue = new NativeCommandQueue({
    liveTargetCM: () => target,
    isActive: () => true,
    dispatch(_cm, key) {
      calls.push(key);
      if (key === "X")
        queue.withNativeFrame(
          () => {
            queue.waitFor(
              new Promise((done) => {
                resolve = done;
              }),
              () => {},
            );
          },
          () => ({
            run: (cm) => {
              calls.push((cm as unknown as { id: string }).id);
            },
          }),
        );
      return true;
    },
  });
  queue.run("Xz");
  await tick();
  expect(calls).toEqual(["X"]);
  target = { id: "new" } as unknown as NativeCM;
  resolve();
  await tick();
  expect(calls).toEqual(["X", "new", "z"]);
  queue.dispose();
});

it("cancels a retained native continuation without running it", async () => {
  const run = vi.fn();
  const cancel = vi.fn();
  const cm = {} as NativeCM;
  const queue = new NativeCommandQueue({
    liveTargetCM: () => cm,
    isActive: () => true,
    dispatch(_cm, key) {
      if (key === "X")
        queue.withNativeFrame(
          () => {
            queue.waitFor(new Promise(() => {}), () => {});
          },
          () => ({ run, cancel }),
        );
      return true;
    },
  });
  queue.run("Xz");
  await tick();
  queue.cancel();
  await queue.settled();
  expect(run).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  queue.dispose();
});

it("marks a deferred physical native key handled so the browser cannot insert it", async () => {
  const e = setup();
  e.queue.run(":s/foo/bar/gc<CR>");
  await tick();
  const deferred = e.queue.intercept(e.cm, "l", "user");
  const handled = deferred && deferred();
  expect(handled).toBe(true);
  if (handled !== true)
    e.view.dispatch(e.view.state.replaceSelection("l"), { userEvent: "input.type" });
  expect(e.view.state.doc.toString()).toBe("foo foo\nlast\nend");
  e.answer("q");
  await tick();
  expect(e.keys).toEqual(["l"]);
});

it("reports a failed native continuation once and discards its remaining tail", async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  const cm = {} as NativeCM;
  const queue = new NativeCommandQueue({
    liveTargetCM: () => cm,
    isActive: () => true,
    onError: (error) => {
      errors.push((error as Error).message);
    },
    dispatch(_cm, key) {
      calls.push(key);
      if (key === "X")
        queue.withNativeFrame(
          () => {
            queue.run("Q");
          },
          () => ({
            run: () => {
              throw new Error("native replay failed");
            },
          }),
        );
      return true;
    },
  });
  queue.run("Xz");
  await tick();
  await queue.settled();
  expect(calls).toEqual(["X", "Q"]);
  expect(errors).toEqual(["native replay failed"]);
  queue.dispose();
});

it("drops a mapping tail when the host suspends during dispatch", async () => {
  let active = true;
  const calls: string[] = [];
  const queue = new NativeCommandQueue({
    liveTargetCM: () => ({}) as NativeCM,
    isActive: () => active,
    dispatch: (_cm, key) => {
      calls.push(key);
      if (key === "j") active = false;
      return true;
    },
  });
  queue.run("jk");
  await tick();
  active = true;
  queue.run("l");
  await tick();
  expect(calls).toEqual(["j", "l"]);
  queue.dispose();
});

function setup(
  nativeEx?: (input: string) => void,
  nativeDispatch?: (cm: NativeCM, key: string) => unknown,
) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: "foo foo\nlast\nend", extensions: history() }),
  });
  cleanups.push(() => view.destroy());
  let dialog: { answer(event: KeyboardEvent): void; close(): void } | undefined;
  const cm = {
    cm6: view,
    state: { vim: { insertMode: false } },
    getValue: () => view.state.doc.toString(),
    operation: <T>(run: () => T) => run(),
    focus: () => view.focus(),
    getCursor: () => {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      return { line: line.number - 1, ch: view.state.selection.main.head - line.from };
    },
    openDialog(
      _template: Node,
      _submit: unknown,
      options: {
        onKeyDown(event: KeyboardEvent, input: string, close: () => void): boolean;
        onClose?(): void;
      },
    ) {
      const close = () => {
        dialog = undefined;
        options.onClose?.();
        (cm as unknown as { focus(): void }).focus();
      };
      dialog = {
        answer: (event) => {
          options.onKeyDown(event, "", close);
        },
        close,
      };
      return close;
    },
  } as unknown as NativeCM;
  const keys: string[] = [];
  const actions = new Map<string, (cm: NativeCM, args: NativeArgs) => void>();
  const vim = {
    defineAction: (name: string, action: (cm: NativeCM, args: NativeArgs) => void) =>
      actions.set(name, action),
    handleEx(_cm: NativeCM, input: string) {
      if (nativeEx) {
        nativeEx(input);
        return;
      }
      expect(input).toBe("s/foo/bar/gc");
      const template = document.createElement("div");
      template.textContent = "replace with bar (y/n/a/q/l)";
      let remaining = (view.state.doc.toString().match(/foo/gu) ?? []).length;
      (cm as unknown as { openDialog: Function }).openDialog(template, undefined, {
        onKeyDown(event: KeyboardEvent, _value: string, close: () => void) {
          if (event.key === "y") {
            const from = view.state.doc.toString().indexOf("foo");
            view.dispatch({ changes: { from, to: from + 3, insert: "bar" }, userEvent: "input" });
            if (--remaining) return true;
          } else if (event.key !== "q" && event.key !== "Escape") return true;
          close();
          // The native stop(close) restores its cursor AFTER it closes the prompt.
          view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
          return true;
        },
      });
    },
  } as unknown as NativeVim;
  const queue = new NativeCommandQueue({
    liveTargetCM: () => cm,
    isActive: () => true,
    dispatch(_cm, key) {
      keys.push(key);
      if (nativeDispatch) return nativeDispatch(_cm, key);
      if (key === "j")
        view.dispatch({ selection: { anchor: view.state.doc.line(cm.getCursor().line + 2).from } });
      return true;
    },
  });
  let active = true;
  let identity = "first";
  const bridge = new NativeExBridge(
    cm,
    vim,
    queue,
    () => active,
    () => identity,
  );
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => bridge.onUpdate(update)),
    ),
  });
  cleanups.push(() => {
    bridge.dispose();
    queue.dispose();
  });
  return {
    view,
    cm,
    vim,
    queue,
    bridge,
    actions,
    keys,
    deactivate: () => {
      active = false;
    },
    switchDocument: () => {
      identity = "second";
    },
    answer: (key: string, options: KeyboardEventInit = {}) =>
      dialog!.answer(new KeyboardEvent("keydown", { key, ...options })),
    dialogOpen: () => !!dialog,
    blur: () => dialog!.close(),
  };
}

it("waits for native confirmation then runs the suffix once after cursor restoration and undoes once", async () => {
  vi.useFakeTimers();
  const e = setup();
  e.queue.run(":s/foo/bar/gc<CR>j");
  await tick();
  expect(e.keys).toEqual([]);
  e.answer("y");
  vi.setSystemTime(Date.now() + 5000);
  expect(e.view.state.doc.toString()).toBe("bar foo\nlast\nend");
  e.answer("y");
  expect(e.keys).toEqual([]);
  await tick();
  expect(e.keys).toEqual(["j"]);
  expect(e.cm.getCursor().line).toBe(2);
  expect(undo(e.view)).toBe(true);
  expect(e.view.state.doc.toString()).toBe("foo foo\nlast\nend");
});

it.each(["blur", "dispose"])("discards the native Ex suffix on %s", async (cancel) => {
  const e = setup();
  e.queue.run(":s/foo/bar/gc<CR>j");
  await tick();
  e.answer("y");
  if (cancel === "dispose") e.bridge.dispose();
  else if (cancel === "blur") e.blur();
  else e.answer(cancel);
  await tick();
  expect(e.keys).toEqual([]);
});

it.each(["q", "Escape"])(
  "finishes native substitution and resumes its suffix on %s",
  async (key) => {
    const e = setup();
    e.queue.run(":s/foo/bar/gc<CR>j");
    await tick();
    e.answer("y");
    e.answer(key);
    await tick();
    expect(e.view.state.doc.toString()).toBe("bar foo\nlast\nend");
    expect(e.keys).toEqual(["j"]);
  },
);

it.each(["q", "Escape"])(
  "keeps replacement and editing suffix in one Undo after %s",
  async (cancel) => {
    vi.useFakeTimers();
    const e = setup(undefined, (_cm, key) => {
      if (key === "Z")
        e.view.dispatch({ changes: { from: 0, to: 1, insert: "Z" }, userEvent: "input" });
      return true;
    });
    e.queue.run(":s/foo/bar/gc<CR>gg0rZ");
    await tick();
    e.answer("y");
    vi.setSystemTime(Date.now() + 5000);
    e.answer(cancel);
    await tick();
    expect(e.view.state.doc.toString()).toBe("Zar foo\nlast\nend");
    undo(e.view);
    expect(e.view.state.doc.toString()).toBe("foo foo\nlast\nend");
  },
);

it("keeps two confirmations and their editing suffix in one Undo", async () => {
  vi.useFakeTimers();
  const e = setup(undefined, (_cm, key) => {
    if (key === "Z")
      e.view.dispatch({ changes: { from: 0, to: 1, insert: "Z" }, userEvent: "input" });
    return true;
  });
  e.queue.run(":s/foo/bar/gc<CR>:s/foo/bar/gc<CR>rZ");
  await tick();
  e.answer("y");
  e.answer("q");
  await tick();
  vi.setSystemTime(Date.now() + 5000);
  e.answer("y");
  await tick();
  expect(e.view.state.doc.toString()).toBe("Zar bar\nlast\nend");
  undo(e.view);
  expect(e.view.state.doc.toString()).toBe("foo foo\nlast\nend");
});

it.each(["c", "["])("cancels native substitution confirmation with Ctrl-%s", async (key) => {
  const e = setup();
  e.queue.run(":s/foo/bar/gc<CR>j");
  await tick();
  e.answer(key, { ctrlKey: true });
  await tick();
  expect(e.dialogOpen()).toBe(false);
  expect(e.keys).toEqual(["j"]);
  await e.queue.settled();
});

it.each(["deactivate", "switchDocument"] as const)(
  "rejects a pending confirmation after %s even before refresh",
  async (change) => {
    const e = setup();
    e.queue.run(":s/foo/bar/gc<CR>j");
    await tick();
    e[change]();
    e.answer("y");
    await tick();
    expect(e.view.state.doc.toString()).toBe("foo foo\nlast\nend");
    expect(e.keys).toEqual([]);
  },
);

it("queues a macro tail behind the mapped RHS before its first microtask", async () => {
  const e = setup();
  e.queue.run(":s/foo/bar/gc<CR>");
  const tail = e.queue.intercept(e.cm, "j", "macro");
  if (tail) tail();
  expect(e.keys).toEqual([]);
  await tick();
  e.answer("y");
  e.answer("y");
  await tick();
  expect(e.keys).toEqual(["j"]);
  expect(e.cm.getCursor().line).toBe(2);
});

it("applies typed Ex clear/backspace/space semantics before native execution", async () => {
  const e = setup();
  e.queue.run(":wrong<C-u>s/foo/barX<BS>/gc<CR>j");
  await tick();
  e.answer("y");
  e.answer("y");
  await tick();
  expect(e.keys).toEqual(["j"]);
});

it("cancels a queued typed Ex prompt and resumes its normal RHS on Escape", async () => {
  const e = setup();
  e.queue.run(":s/foo/bar/gc<Esc><CR>j");
  await tick();
  expect(e.view.state.doc.toString()).toBe("foo foo\nlast\nend");
  expect(e.keys).toEqual(["<CR>", "j"]);
});

it.each(["<Esc>", "<BS>"])(
  "terminates an unsubmitted no-CR Ex prompt with %s",
  async (terminator) => {
    const e = setup(undefined, (_cm, key) => {
      if (key === ":") {
        (
          e.cm as unknown as {
            openDialog(template: Node, submit: undefined, options: object): () => void;
          }
        ).openDialog(document.createTextNode(":"), undefined, {});
      }
      return true;
    });
    e.queue.run(`:${terminator}l`);
    await tick();
    expect(e.dialogOpen()).toBe(false);
    expect(e.keys).toEqual(["l"]);
  },
);

it("does not append a Normal Enter after a compiled no-CR Ex cancellation", async () => {
  const e = setup();
  const command = e.bridge.mapping({ mode: "normal", from: "Q", to: ":<Esc>l" });
  e.actions.get(command.action!)!(e.cm, { ...command.actionArgs, repeat: 1 });
  await tick();
  expect(e.keys).toEqual(["l"]);
});

it("keeps a literal colon motion target out of Ex prompt parsing", async () => {
  const e = setup(
    () => {},
    (cm, key) => {
      if (key === "f") cm.state.vim!.expectLiteralNext = true;
      if (key === ":") cm.state.vim!.expectLiteralNext = false;
      return true;
    },
  );
  e.queue.run(":s/foo/bar/gc<CR>f:<Esc>");
  await tick();
  expect(e.keys).toEqual(["f", ":", "<Esc>"]);
});

it("leaves an empty Ex prompt on Backspace before later Normal and Insert keys", async () => {
  const e = setup(undefined, (cm, key) => {
    if (key === "i") {
      cm.state.vim!.insertMode = true;
      return true;
    }
    if (key === "<Esc>") {
      cm.state.vim!.insertMode = false;
      return true;
    }
    return false;
  });
  e.queue.run(":<BS>iX<Esc><CR>");
  await tick();
  expect(e.view.state.doc.toString()).toBe("Xfoo foo\nlast\nend");
  expect(e.cm.state.vim?.insertMode).toBe(false);
});

it("inserts a supplementary Unicode character in the native mapping suffix", async () => {
  const e = setup(
    () => {},
    (cm, key) => {
      if (key === "i") {
        cm.state.vim!.insertMode = true;
        return true;
      }
      if (key === "<Esc>") {
        cm.state.vim!.insertMode = false;
        return true;
      }
      return false;
    },
  );
  e.queue.run(":s/foo/bar/gc<CR>i😀<Esc>");
  await tick();
  expect(e.view.state.doc.toString()).toBe("😀foo foo\nlast\nend");
});

it("keeps focus on a recreated native cell when the recording notification closes", () => {
  const e = setup();
  const close = (
    e.cm as unknown as {
      openDialog(template: Node, submit: () => void, options: object): () => void;
    }
  ).openDialog(document.createTextNode("(recording)[a]"), () => {}, {});
  const cell = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: "cell" }),
  });
  cleanups.push(() => cell.destroy());
  cell.focus();
  close();
  expect(document.activeElement).toBe(cell.contentDOM);
});

it("seeds the visual range when a mapped key sequence reaches colon after entering Visual", async () => {
  const inputs: string[] = [];
  const e = setup(
    (input) => {
      inputs.push(input);
    },
    (cm, key) => {
      if (key === "V") cm.state.vim!.visualMode = true;
      return true;
    },
  );
  e.queue.run("Vj:s/foo/bar/gc<CR>");
  await tick();
  expect(inputs).toEqual(["'<,'>s/foo/bar/gc"]);
});

it("holds counted native open actions and their Insert tail in one undo group", () => {
  vi.useFakeTimers();
  const e = setup();
  e.bridge.beginInsertGroup();
  e.view.dispatch({ changes: { from: 0, insert: "- one\n" }, userEvent: "input.type" });
  vi.setSystemTime(Date.now() + 5000);
  e.bridge.beginInsertGroup();
  e.view.dispatch({ changes: { from: 0, insert: "- two\n" }, userEvent: "input.type" });
  e.bridge.endInsertGroup();
  expect(undo(e.view)).toBe(true);
  expect(e.view.state.doc.toString()).toBe("foo foo\nlast\nend");
});

it.each([
  [false, 3, ".,.+2s/foo/bar/gc"],
  [true, 1, "'<,'>s/foo/bar/gc"],
] as const)(
  "preserves native colon context (visual=%s, repeat=%s)",
  async (visual, repeat, expected) => {
    const inputs: string[] = [];
    const e = setup((input) => {
      inputs.push(input);
    });
    e.cm.state.vim!.visualMode = visual;
    const command = e.bridge.mapping({
      mode: visual ? "visual" : "normal",
      from: "Q",
      to: ":s/foo/bar/gc<CR>",
    });
    const action = e.actions.get(command.action!)!;
    action(e.cm, { ...command.actionArgs, repeat });
    await tick();
    expect(inputs).toEqual([expected]);
  },
);

it("invalidates a pending confirmation after an external document change", async () => {
  const e = setup();
  e.view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => e.bridge.onUpdate(update)),
    ),
  });
  e.queue.run(":s/foo/bar/gc<CR>j");
  await tick();
  e.view.dispatch({ changes: { from: 0, insert: "external " }, userEvent: "set" });
  await tick();
  expect(e.view.state.doc.toString()).toBe("external foo foo\nlast\nend");
  expect(e.keys).toEqual([]);
});

it("disposes a bridge during native editor reconfiguration without dispatching recursively", async () => {
  const e = setup();
  e.view.dispatch({
    effects: StateEffect.appendConfig.of(
      ViewPlugin.define(() => ({ destroy: () => e.bridge.dispose() })),
    ),
  });
  expect(() => e.view.setState(EditorState.create({ doc: "replacement" }))).not.toThrow();
  await tick();
  expect(e.view.state.doc.toString()).toBe("replacement");
});
