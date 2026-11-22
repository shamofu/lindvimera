import { describe, expect, it } from "vitest";
import { adjacentCellPosition, cellPosition, sourcePosition } from "../../src/table/motion";
import { parseMarkdownTable, type MarkdownTable } from "../../src/table/source";

describe("native cell/source coordinates", () => {
  it("round trips editable newlines and escaped pipes without targeting hidden syntax", () => {
    const table = parseMarkdownTable("| A | B |\n| --- | --- |\n| a\\|b<br>日本語 |  |");
    for (const cell of table.rows.flat()) {
      for (let offset = 0; offset <= cell.map.text.length; offset++) {
        const position = { row: cell.row, column: cell.column, offset };
        expect(cellPosition(table, sourcePosition(table, position))).toEqual(position);
      }
    }
  });

  it("computes adjacent cell destinations with counts, clamping, and empty table guard", () => {
    const table = parseMarkdownTable("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
    expect(adjacentCellPosition(table, { row: 0, column: 0 }, true)).toEqual({
      row: 0,
      column: 1,
      offset: 0,
    });
    expect(adjacentCellPosition(table, { row: 0, column: 2 }, true)).toEqual({
      row: 1,
      column: 0,
      offset: 0,
    });
    expect(adjacentCellPosition(table, { row: 1, column: 0 }, false)).toEqual({
      row: 0,
      column: 2,
      offset: 0,
    });
    expect(adjacentCellPosition(table, { row: 0, column: 0 }, true, 4)).toEqual({
      row: 1,
      column: 1,
      offset: 0,
    });
    expect(adjacentCellPosition(table, { row: 1, column: 2 }, false, 3)).toEqual({
      row: 0,
      column: 2,
      offset: 0,
    });
    // Normalizes non-positive count to 1
    expect(adjacentCellPosition(table, { row: 0, column: 1 }, true, 0)).toEqual({
      row: 0,
      column: 2,
      offset: 0,
    });
    // Clamps at boundaries (0, 0) and (lastRow, lastCol)
    expect(adjacentCellPosition(table, { row: 0, column: 0 }, false)).toEqual({
      row: 0,
      column: 0,
      offset: 0,
    });
    expect(adjacentCellPosition(table, { row: 0, column: 1 }, false, 10)).toEqual({
      row: 0,
      column: 0,
      offset: 0,
    });
    expect(adjacentCellPosition(table, { row: 1, column: 2 }, true)).toEqual({
      row: 1,
      column: 2,
      offset: 0,
    });
    expect(adjacentCellPosition(table, { row: 0, column: 1 }, true, 20)).toEqual({
      row: 1,
      column: 2,
      offset: 0,
    });
    // Empty table or zero columns
    const emptyRows: MarkdownTable = {
      from: 0,
      to: 0,
      source: "",
      rows: [],
      separator: { from: 0, to: 0 },
      alignments: [],
    };
    const zeroCols: MarkdownTable = {
      from: 0,
      to: 0,
      source: "",
      rows: [[]],
      separator: { from: 0, to: 0 },
      alignments: [],
    };
    expect(adjacentCellPosition(emptyRows, { row: 0, column: 0 }, true)).toBeUndefined();
    expect(adjacentCellPosition(zeroCols, { row: 0, column: 0 }, true)).toBeUndefined();
  });
});
