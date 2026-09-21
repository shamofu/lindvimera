import { EditorState } from "@codemirror/state";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { nativeCellIdentity, resolveNativeTable } from "../../src/table/native-adapter";
import { parseMarkdownTable } from "../../src/table/source";

function fakeView(doc: string) {
  const view = {
    state: EditorState.create({ doc }),
    contentDOM: {},
    composing: false,
    focus: vi.fn(),
    dispatch: (spec: TransactionSpec) => {
      view.state = view.state.update(spec).state;
    },
  };
  return view;
}
function fixture(prefix = "", suffix = "") {
  const source = "| A | B |\n| --- | --- |\n| one | two |";
  const model = parseMarkdownTable(source, prefix.length);
  const parent = fakeView(prefix + source + suffix);
  const cellView = fakeView("one");
  const owner = {
    cm: parent,
    tableCell: null as unknown,
    destroyTableCell: vi.fn(() => {
      owner.tableCell = null;
    }),
    editTableCell: vi.fn(),
  };
  const table = {
    start: prefix.length,
    end: prefix.length + source.length,
    editor: owner,
    rows: [] as unknown[][],
    getCellAt: (row: number, column: number) => table.rows[row]?.[column] ?? null,
    deselectCells: vi.fn(),
  };
  table.rows = model.rows.map((row) =>
    row.map((cell) => ({
      row: cell.row,
      col: cell.column,
      text: cell.map.source,
      table,
      getAbsoluteOffsets: () => ({
        start: cell.from,
        end: cell.to,
        textStart: cell.content.from,
        textEnd: cell.content.to,
      }),
    })),
  );
  owner.editTableCell.mockImplementation((_table, cell: { text: string }) => {
    const input = { cell, table, cm: fakeView(cell.text) };
    owner.tableCell = input;
    return input;
  });
  owner.tableCell = { cell: table.rows[1]![0], table, cm: cellView };
  return { source, parent, cellView, owner, table };
}

describe("isolated native table compatibility adapter", () => {
  it("resolves only the supplied parent/cell pane", () => {
    const { owner, cellView } = fixture();
    expect(resolveNativeTable(owner, cellView as unknown as EditorView).supported).toBe(true);
    expect(
      resolveNativeTable(owner, fakeView("different") as unknown as EditorView).supported,
    ).toBe(false);
    expect(resolveNativeTable({}).supported).toBe(false);
  });

  it("refuses unsynchronized text and unsupported source offsets", () => {
    const { owner, cellView, table } = fixture();
    cellView.dispatch({ changes: { from: 0, to: 3, insert: "pending" } });
    expect(resolveNativeTable(owner)).toMatchObject({
      supported: false,
      reason: expect.stringContaining("not synchronized"),
    });
    cellView.dispatch({ changes: { from: 0, to: 7, insert: "one" } });
    table.start = -1;
    expect(resolveNativeTable(owner).supported).toBe(false);
  });

  it("reads target-local coordinates and clamps explicit focus to current native text", () => {
    const { owner, parent, cellView, source } = fixture();
    const result = resolveNativeTable(owner);
    if (!result.supported) throw new Error(result.reason);
    cellView.dispatch({ selection: { anchor: 2 } });
    expect(result.context.position()).toEqual({ row: 1, column: 0, offset: 2 });
    const next = result.context.focus({ row: 1, column: 1, offset: 99 });
    expect(next.state.selection.main.head).toBe(3);
    expect(next.focus).toHaveBeenCalledOnce();
    expect(parent.state.doc.toString()).toBe(source);
    expect(() => result.context.focus({ row: 99, column: 1, offset: 0 })).toThrow(
      "no longer exists",
    );
  });

  it("stops leaving at document edges without closing the active cell", () => {
    const { owner, parent, source } = fixture();
    const result = resolveNativeTable(owner);
    if (!result.supported) throw new Error(result.reason);
    expect(result.context.canLeave("before")).toBe(false);
    expect(result.context.canLeave("after")).toBe(false);
    result.context.leave("before");
    result.context.leave("after");
    expect(owner.destroyTableCell).not.toHaveBeenCalled();
    expect(parent.state.doc.toString()).toBe(source);
  });

  it.each(["before", "after"] as const)(
    "closes native input and focuses adjacent %s prose",
    (direction) => {
      const { owner, parent, source } = fixture("before\n", "\nafter");
      const result = resolveNativeTable(owner);
      if (!result.supported) throw new Error(result.reason);
      expect(result.context.canLeave(direction)).toBe(true);
      result.context.leave(direction);
      expect(owner.destroyTableCell).toHaveBeenCalledOnce();
      expect(parent.state.selection.main.head).toBe(
        direction === "before" ? 0 : "before\n".length + source.length + 1,
      );
      expect(parent.focus).toHaveBeenCalledOnce();
      expect(parent.state.doc.toString()).toBe(`before\n${source}\nafter`);
    },
  );

  it("retains a logical identity across recreation and changes it on cell navigation", () => {
    const { owner, parent, table } = fixture();
    const identity = nativeCellIdentity(owner, parent as unknown as EditorView);
    owner.tableCell = { cell: table.rows[1]![0], table, cm: fakeView("one") };
    expect(nativeCellIdentity(owner, parent as unknown as EditorView)).toBe(identity);
    owner.tableCell = { cell: table.rows[1]![1], table, cm: fakeView("two") };
    expect(nativeCellIdentity(owner, parent as unknown as EditorView)).not.toBe(identity);
    expect(
      nativeCellIdentity(owner, fakeView("other pane") as unknown as EditorView),
    ).toBeUndefined();
  });
});
