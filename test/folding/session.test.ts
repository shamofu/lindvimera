import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  codeFolding,
  foldEffect,
  foldedRanges,
  foldService,
  StreamLanguage,
} from "@codemirror/language";
import { history, undoDepth } from "@codemirror/commands";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { clearFolding, configureFolding, revealFoldedRange } from "../../src/folding";
import { PendingCommands } from "../../src/runtime/pending";
import { VimHistoryGroup } from "../../src/runtime/history";
import { NativeHostFixture } from "../table/host-fixture";
import { editorSession } from "../../src/runtime/editor";

const dispose: (() => void)[] = [];
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
beforeEach(() => Vim.resetVimGlobalState_());
afterEach(() => {
  for (const cleanup of dispose.splice(0)) cleanup();
  document.body.replaceChildren();
});

const source =
  "# Parent\nbody\n## Child\nchild text\n## Sibling\nsibling text\n# Other\nother text";
function create(text = source, withParser = false) {
  let identity: unknown = {};
  let enabled = true;
  const errors: string[] = [];
  const group = new VimHistoryGroup();
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        group.extension,
        vim(),
        codeFolding(),
        withParser
          ? StreamLanguage.define({
              token(stream) {
                stream.skipToEnd();
                return null;
              },
            })
          : [],
        foldService.of((state, start, end) => {
          const line = state.doc.lineAt(start);
          const match = /^(#+) /.exec(line.text);
          if (!match) return null;
          let stop = state.doc.length;
          for (let next = line.number + 1; next <= state.doc.lines; next++) {
            const following = state.doc.line(next);
            const heading = /^(#+) /.exec(following.text);
            if (heading && heading[1].length <= match[1].length) {
              stop = following.from - 1;
              break;
            }
          }
          return stop > end ? { from: end, to: stop } : null;
        }),
      ],
    }),
  });
  const cm = getCM(view)!;
  group.attach(cm);
  const pending = new PendingCommands(cm, group, (message) => errors.push(message));
  configureFolding(cm, {
    enabled: () => enabled,
    documentIdentity: () => identity,
    waitFor: (task, cancel) => pending.waitFor(task, cancel),
  });
  dispose.push(() => {
    clearFolding(cm);
    pending.destroy();
    group.destroy();
    view.destroy();
  });
  return {
    view,
    cm,
    pending,
    errors,
    disable: () => {
      enabled = false;
    },
    changeIdentity: () => {
      identity = {};
    },
  };
}
function keys(cm: ReturnType<typeof create>["cm"], sequence: string): void {
  for (const key of sequence.match(/<[^>]+>|./gu) ?? [])
    cm.operation(() => Vim.handleKey(cm, key, "user"));
}
async function settle(fixture: ReturnType<typeof create>) {
  for (let index = 0; index < 100 && fixture.pending.pending; index++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(fixture.pending.pending).toBe(false);
}
function closed(view: EditorView): number[] {
  const lines: number[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from) => {
    lines.push(view.state.doc.lineAt(from).number);
  });
  return lines.sort((a, b) => a - b);
}

describe("folding command sessions", () => {
  it("folds a containing range, exposes the cursor and preserves text history", async () => {
    const f = create();
    f.cm.setCursor({ line: 3, ch: 2 });
    keys(f.cm, "2zc");
    await settle(f);
    expect(closed(f.view)).toEqual([1, 3]);
    expect(f.cm.getCursor()).toEqual({ line: 0, ch: 0 });
    expect(f.view.state.doc.toString()).toBe(source);
    expect(undoDepth(f.view.state)).toBe(0);
    expect(f.errors).toEqual([]);
    keys(f.cm, "zO");
    await settle(f);
    expect(closed(f.view)).toEqual([]);
  });

  it("globally closes hidden descendants and reopens all folds", async () => {
    const f = create();
    keys(f.cm, "zM");
    await settle(f);
    expect(closed(f.view)).toEqual([1, 3, 5, 7]);
    keys(f.cm, "zo");
    await settle(f);
    expect(closed(f.view)).toEqual([3, 5, 7]);
    keys(f.cm, "zR");
    await settle(f);
    expect(closed(f.view)).toEqual([]);
  });

  it.each(["v", "V", "<C-v>"])("applies %s ranges and saves selection for gv", async (visual) => {
    const f = create();
    keys(f.cm, `3G${visual}5GzC`);
    await settle(f);
    expect(f.cm.state.vim!.visualMode).toBe(false);
    expect(closed(f.view)).toEqual([1, 3, 5]);
    keys(f.cm, "gv");
    expect(f.cm.state.vim!.visualMode).toBe(true);
    expect(f.cm.state.vim!.sel.anchor.line).toBe(2);
    expect(f.cm.state.vim!.sel.head.line).toBe(4);
  });

  it("preserves the last text edit and register through folding", async () => {
    const f = create();
    keys(f.cm, "2G0x");
    const text = f.view.state.doc.toString();
    const register = Vim.getRegisterController().getRegister('"').toString();
    keys(f.cm, "zc");
    await settle(f);
    keys(f.cm, "zo");
    await settle(f);
    expect(Vim.getRegisterController().getRegister('"').toString()).toBe(register);
    expect(f.view.state.doc.toString()).toBe(text);
    expect(undoDepth(f.view.state)).toBe(1);
    keys(f.cm, "2G0.");
    expect(f.view.state.doc.line(2).text).toBe("dy");
  });

  it("records and replays macros across asynchronous fold commands", async () => {
    const f = create();
    keys(f.cm, "qazc");
    await settle(f);
    keys(f.cm, "zo");
    await settle(f);
    keys(f.cm, "2Gq");
    f.cm.setCursor({ line: 0, ch: 0 });
    keys(f.cm, "@a");
    await settle(f);
    expect(f.cm.getCursor().line).toBe(1);
    expect(closed(f.view)).toEqual([]);
    expect(f.errors).toEqual([]);
  });

  it("isolates panes and does nothing in a native cell or while disabled", async () => {
    const a = create();
    const b = create();
    keys(a.cm, "zM");
    await settle(a);
    expect(closed(b.view)).toEqual([]);
    b.disable();
    keys(b.cm, "zM");
    expect(b.pending.pending).toBe(false);
    const c = create();
    vi.spyOn(c.cm, "getEditingView").mockReturnValue(b.view);
    keys(c.cm, "zM");
    expect(c.pending.pending).toBe(false);
    expect(closed(c.view)).toEqual([]);
  });

  it("cancels before applying effects after a document change or explicit cancellation", async () => {
    const f = create();
    keys(f.cm, "zM");
    f.changeIdentity();
    await settle(f);
    expect(closed(f.view)).toEqual([]);
    expect(f.errors).toHaveLength(1);
    keys(f.cm, "zM");
    f.pending.cancel();
    await settle(f);
    await Promise.resolve();
    expect(closed(f.view)).toEqual([]);
    expect(f.errors).toHaveLength(1);
  });

  it("parses and folds the whole document beyond the initial viewport", async () => {
    const f = create(`# Start\nbody\n${"plain text\n".repeat(1800)}# End\nbody`, true);
    keys(f.cm, "zM");
    await settle(f);
    expect(closed(f.view)).toEqual([1, 1803]);
    expect(f.errors).toEqual([]);
  });

  it("does not apply a partial result when text changes during range scanning", async () => {
    const f = create(`${source}\n${"plain text\n".repeat(800)}# End\nbody`);
    keys(f.cm, "zM");
    await Promise.resolve();
    expect(f.pending.pending).toBe(true);
    f.view.dispatch({ changes: { from: 0, insert: "new line\n" } });
    await settle(f);
    expect(closed(f.view)).toEqual([]);
    expect(f.errors).toHaveLength(1);
  });

  it("reveals every containing fold before a native table is restored", () => {
    const f = create();
    const parent = { from: f.view.state.doc.line(1).to, to: f.view.state.doc.line(6).to };
    const child = { from: f.view.state.doc.line(3).to, to: f.view.state.doc.line(4).to };
    f.view.dispatch({ effects: [foldEffect.of(parent), foldEffect.of(child)] });
    revealFoldedRange(f.view, f.view.state.doc.line(4).from, f.view.state.doc.line(4).to);
    expect(closed(f.view)).toEqual([]);
    expect(undoDepth(f.view.state)).toBe(0);
  });

  it("restores a marked cell after its parent heading has hidden the table widget", async () => {
    const host = new NativeHostFixture(
      "| A | B |\n| --- | --- |\n| one | two |",
      "# Parent\n",
      "\nafter",
    );
    dispose.push(() => host.destroy());
    host.focus({ row: 1, column: 1, offset: 2 });
    host.keys("ma[t");
    host.cm.dispatch({ effects: StateEffect.appendConfig.of(codeFolding()) });
    host.cm.dispatch({
      effects: foldEffect.of({ from: host.cm.state.doc.line(1).to, to: host.table.end }),
    });
    expect(closed(host.cm)).toEqual([1]);
    host.keys("`a");
    const pending = editorSession(host.cm)!.pending;
    for (let index = 0; index < 100 && pending.pending; index++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pending.pending).toBe(false);
    expect(closed(host.cm)).toEqual([]);
    expect(host.tableCell!.cell.col).toBe(1);
    expect(host.tableCell!.cm.state.selection.main.head).toBe(2);
  });
});
