import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  cellTarget,
  mapParentPosition,
  mapReplacedText,
  type NavigationPosition,
} from "../../src/navigation/positions";
import { parseMarkdownTable } from "../../src/table/source";

const source = "| A | B |\n| --- | --- |\n| one | two |\n| last | keep |";
function fixture(row = 1, column = 0, offset = 1) {
  const state = EditorState.create({ doc: source });
  const table = parseMarkdownTable(source);
  const position: NavigationPosition = {
    target: cellTarget(table, table.rows[row][column]),
    offset,
    valid: true,
  };
  return { state, table, position };
}

describe("persistent source positions", () => {
  it("tracks body edits and invalidates deleted text", () => {
    const state = EditorState.create({ doc: "abc def" });
    const position: NavigationPosition = { target: { kind: "body" }, offset: 4, valid: true };
    const insert = state.update({ changes: { from: 0, insert: "prefix " } });
    mapParentPosition(position, insert.changes, insert.state.doc, []);
    expect(position.offset).toBe(11);
    const remove = insert.state.update({ changes: { from: 10, to: 14 } });
    mapParentPosition(position, remove.changes, remove.state.doc, []);
    expect(position.valid).toBe(false);
  });

  it("moves a marked cell across a newly inserted row", () => {
    const { state, table, position } = fixture(2);
    const at = state.doc.lineAt(table.rows[2][0].from).from;
    const transaction = state.update({ changes: { from: at, insert: "| new | row |\n" } });
    mapParentPosition(position, transaction.changes, transaction.state.doc, []);
    expect(position.valid).toBe(true);
    expect(position.target).toMatchObject({ row: 3, column: 0 });
    expect(position.offset).toBe(1);
  });

  it("invalidates a removed row rather than moving to the replacement row", () => {
    const { state, table, position } = fixture(1);
    const line = state.doc.lineAt(table.rows[1][0].from);
    const transaction = state.update({ changes: { from: line.from, to: line.to + 1 } });
    mapParentPosition(position, transaction.changes, transaction.state.doc, []);
    expect(position.valid).toBe(false);
  });

  it.each([0, 1, 2])("recovers offset %s when the host replaces the complete cell", (offset) => {
    const { state, table, position } = fixture(1, 0, offset);
    const cell = table.rows[1][0];
    const transaction = state.update({
      changes: { from: cell.content.from, to: cell.content.to, insert: "prefix one" },
    });
    mapParentPosition(position, transaction.changes, transaction.state.doc, []);
    expect(position.valid).toBe(true);
    expect(position.offset).toBe(offset + 7);
  });

  it("maps precise native edits only once across complete-table reformatting", () => {
    const { state, position } = fixture();
    const target = position.target;
    if (target.kind !== "cell") throw new Error("cell expected");
    const other = fixture(1, 1).position;
    position.offset = 3; // Already mapped by the native insertion of xx before one.
    const text = "| A     | B    |\n| ----- | ---- |\n| xxone | two  |\n| last  | keep |";
    const transaction = state.update({ changes: { from: 0, to: source.length, insert: text } });
    const mirror = [{ target: { ...target }, text: "xxone" }];
    mapParentPosition(position, transaction.changes, transaction.state.doc, mirror);
    mapParentPosition(other, transaction.changes, transaction.state.doc, mirror);
    expect(position.valid).toBe(true);
    expect(position.offset).toBe(3);
    expect(other.valid).toBe(true);
    expect(other.offset).toBe(1);
  });

  it("does not treat a deleted whole table as another target", () => {
    const { state, position } = fixture();
    const transaction = state.update({ changes: { from: 0, to: source.length, insert: "gone" } });
    mapParentPosition(position, transaction.changes, transaction.state.doc, []);
    expect(position.valid).toBe(false);
  });

  it("tracks the unchanged suffix of a replacement, including insertion at the mark", () => {
    expect(mapReplacedText("a|b\n続き", "a|prefix b\n続き", 4)).toBe(11);
    expect(mapReplacedText("abc", "axc", 1)).toBeNull();
    expect(mapReplacedText("abc", "abc", 1)).toBe(1);
    expect(mapReplacedText("abc", "xabc", 0)).toBe(1);
  });
});
