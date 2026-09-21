import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undoDepth } from "@codemirror/commands";
import { getCM, Vim } from "@replit/codemirror-vim";
import { editorSession, lindvimeraEditor } from "../../src/runtime/editor";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { NativeHostFixture } from "../table/host-fixture";
import { resolveNativeTableAt } from "../../src/table/native-adapter";
import { parseMarkdownTable } from "../../src/table/source";

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

function body(text = "  alpha\nbeta\ngamma") {
  let identity: unknown = {};
  const errors: string[] = [];
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        lindvimeraEditor({
          settings: () => DEFAULT_SETTINGS,
          owner: () => undefined,
          documentIdentity: () => identity,
          error: (message) => errors.push(message),
        }),
      ],
    }),
  });
  dispose.push(() => view.destroy());
  const session = editorSession(view)!;
  return {
    view,
    session,
    cm: getCM(view)!,
    errors,
    identity: (next: unknown) => {
      identity = next;
    },
  };
}
async function settle(session: ReturnType<typeof editorSession>): Promise<void> {
  for (let i = 0; i < 100 && session?.pending.pending; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(session?.pending.pending).toBe(false);
}
function keys(cm: NonNullable<ReturnType<typeof getCM>>, sequence: string): void {
  for (const key of sequence.match(/<[^>]+>|./gu) ?? [])
    cm.operation(() => Vim.handleKey(cm, key, "user"));
}

describe("document navigation", () => {
  it("sets local marks and restores exact or first nonblank positions without history", async () => {
    const f = body();
    f.cm.setCursor({ line: 0, ch: 5 });
    keys(f.cm, "maG`a");
    await settle(f.session);
    expect(f.cm.getCursor()).toEqual({ line: 0, ch: 5 });
    keys(f.cm, "G'a");
    await settle(f.session);
    expect(f.cm.getCursor()).toEqual({ line: 0, ch: 2 });
    expect(undoDepth(f.view.state)).toBe(0);
  });

  it("isolates panes, rejects deleted marks, and resets on a different document", async () => {
    const a = body();
    const b = body();
    a.cm.setCursor({ line: 0, ch: 4 });
    keys(a.cm, "ma");
    keys(b.cm, "`a");
    await settle(b.session);
    expect(b.errors).toHaveLength(1);
    a.view.dispatch({ changes: { from: 3, to: 6 } });
    keys(a.cm, "`a");
    await settle(a.session);
    expect(a.errors).toHaveLength(1);
    keys(a.cm, "mb");
    a.identity({});
    keys(a.cm, "`b");
    await settle(a.session);
    expect(a.errors).toHaveLength(2);
  });

  it("retains at most 100 positions and clamps extreme jump counts", async () => {
    const f = body("x".repeat(130));
    for (let offset = 0; offset < 120; offset++)
      f.cm.state.navigationProvider!.recordJump(
        { line: 0, ch: offset },
        { line: 0, ch: offset + 1 },
      );
    f.cm.setCursor({ line: 0, ch: 120 });
    f.session.navigation.walk(-1, 99999);
    await settle(f.session);
    expect(f.cm.getCursor().ch).toBe(21);
    f.session.navigation.walk(1, 99999);
    await settle(f.session);
    expect(f.cm.getCursor().ch).toBe(120);
  });

  it("discards the forward branch after a new jump", async () => {
    const f = body("0123456789");
    const p = f.cm.state.navigationProvider!;
    p.recordJump({ line: 0, ch: 0 }, { line: 0, ch: 3 });
    p.recordJump({ line: 0, ch: 3 }, { line: 0, ch: 6 });
    f.cm.setCursor({ line: 0, ch: 6 });
    f.session.navigation.walk(-1, 1);
    await settle(f.session);
    p.recordJump({ line: 0, ch: 3 }, { line: 0, ch: 8 });
    f.cm.setCursor({ line: 0, ch: 8 });
    f.session.navigation.walk(1, 1);
    await settle(f.session);
    expect(f.cm.getCursor().ch).toBe(8);
  });

  it("reports a deleted jump destination and preserves the history pointer", async () => {
    const f = body("0123456789");
    f.cm.state.navigationProvider!.recordJump({ line: 0, ch: 2 }, { line: 0, ch: 8 });
    f.cm.setCursor({ line: 0, ch: 8 });
    f.view.dispatch({ changes: { from: 1, to: 4 } });
    const origin = f.cm.getCursor();
    f.session.navigation.walk(-1, 1);
    await settle(f.session);
    expect(f.cm.getCursor()).toEqual(origin);
    expect(f.errors).toHaveLength(1);
    f.session.navigation.walk(-1, 1);
    await settle(f.session);
    expect(f.cm.getCursor()).toEqual(origin);
    expect(f.errors).toHaveLength(2);
  });

  it("cancels before a delayed restoration can move to a new document", async () => {
    const f = body();
    keys(f.cm, "maG`a");
    f.identity({});
    f.session.navigation.reset();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.cm.getCursor().line).toBe(2);
    expect(f.session.pending.pending).toBe(false);
  });

  it("stops a macro at a missing mark before its following edit", async () => {
    const f = body("abc");
    Vim.getRegisterController().getRegister("z").setText("`ax");
    keys(f.cm, "@z");
    await settle(f.session);
    expect(f.cm.getValue()).toBe("abc");
    expect(f.errors).toHaveLength(1);
  });
});

describe("native navigation", () => {
  function native() {
    const host = new NativeHostFixture(
      "| A | B |\n| --- | --- |\n| one | a\\|b<br>続き |\n| last | keep |",
      "before\n",
      "\nafter",
    );
    dispose.push(() => host.destroy());
    return { host, session: editorSession(host.cm)! };
  }

  it("survives cell destruction and maps precise edits before whole-cell serialization", async () => {
    const { host, session } = native();
    host.focus({ row: 1, column: 1, offset: 4 });
    host.keys("ma");
    host.tableCell!.cm.dispatch({ changes: { from: 0, insert: "xx" } });
    host.focus({ row: 1, column: 0, offset: 0 });
    host.keys("`a");
    await settle(session);
    expect(host.tableCell!.cell.col).toBe(1);
    expect(host.tableCell!.cm.state.selection.main.head).toBe(6);
    expect(host.values()[1][1]).toBe("xxa|b\n続き");
  });

  it("moves between body and a closed cell and exposes Ex marks only within their target", async () => {
    const { host, session } = native();
    host.focus({ row: 1, column: 1, offset: 4 });
    host.keys("ma[t");
    expect(host.engine.state.navigationProvider!.resolveMark("a")).toBeNull();
    host.keys("mb`a");
    await settle(session);
    expect(host.engine.state.navigationProvider!.resolveMark("a")).toEqual({ line: 1, ch: 0 });
    host.keys("`b");
    await settle(session);
    expect(host.tableCell).toBeNull();
    expect(host.cm.state.selection.main.head).toBe(0);
  });

  it("waits for an offscreen widget to materialize before reopening its cell", async () => {
    const { host, session } = native();
    host.keys("ma[t");
    const rows = host.table.rows;
    host.table.rows = [];
    host.keys("`a");
    expect(session.pending.pending).toBe(true);
    setTimeout(() => {
      host.table.rows = rows;
    }, 30);
    await settle(session);
    expect(host.tableCell!.cell.row).toBe(1);
    expect(host.tableCell!.cell.col).toBe(0);
  });

  it("requests source scrolling even when the destination widget is already materialized", async () => {
    const { host, session } = native();
    host.focus({ row: 2, column: 1, offset: 2 });
    host.keys("ma[t");
    expect(resolveNativeTableAt(host, host.cm, host.table.start, host.table.end).supported).toBe(
      true,
    );
    const table = parseMarkdownTable(
      host.cm.state.doc.sliceString(host.table.start, host.table.end),
      host.table.start,
    );
    const scroll = vi.spyOn(EditorView, "scrollIntoView");
    host.keys("`a");
    await settle(session);
    expect(scroll).toHaveBeenCalledWith(table.rows[2][1].from, { y: "center" });
    expect(host.tableCell!.cell.row).toBe(2);
    expect(host.tableCell!.cell.col).toBe(1);
    expect(host.tableCell!.cm.state.selection.main.head).toBe(2);
  });

  it("reports an unavailable table, retains the origin, and stops a macro's remaining edit", async () => {
    const { host, session } = native();
    const errors: string[] = [];
    host.onError = (message) => errors.push(message);
    host.keys("ma[t");
    host.table.rows = [];
    const before = host.cm.state.doc.toString();
    Vim.getRegisterController().getRegister("z").setText("`ax");
    host.keys("@z");
    await settle(session);
    expect(errors).toHaveLength(1);
    expect(host.cm.state.doc.toString()).toBe(before);
    expect(host.cm.state.selection.main.head).toBe(0);
    expect(host.tableCell).toBeNull();
  });

  it("cancels offscreen restoration before later widget materialization", async () => {
    const { host, session } = native();
    host.keys("ma[t");
    const rows = host.table.rows;
    host.table.rows = [];
    host.keys("`a");
    await Promise.resolve();
    session.pending.cancel();
    host.table.rows = rows;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(host.tableCell).toBeNull();
    expect(host.cm.state.selection.main.head).toBe(0);
  });
});
