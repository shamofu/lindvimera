import { describe, expect, it } from "vitest";
import { cellPosition, sourcePosition } from "../../src/table/motion";
import { parseMarkdownTable } from "../../src/table/source";

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
});
