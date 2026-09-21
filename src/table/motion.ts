import type { CellPosition } from "./selection";
import { displayToSource, sourceToDisplay } from "./source";
import type { MarkdownTable } from "./source";

export function sourcePosition(table: MarkdownTable, position: CellPosition): number {
  const cell = table.rows[position.row][position.column];
  return displayToSource(cell.map, Math.min(position.offset, cell.map.text.length));
}

export function cellPosition(table: MarkdownTable, offset: number, bias: -1 | 1 = 1): CellPosition {
  const cells = table.rows.flat();
  const cell =
    cells.find((item) => offset >= item.from && offset <= item.to) ??
    (bias === 1
      ? cells.find((item) => item.from > offset)
      : [...cells].reverse().find((item) => item.to < offset)) ??
    (bias === 1 ? cells[cells.length - 1] : cells[0]);
  const source = Math.max(cell.content.from, Math.min(cell.content.to, offset));
  return { row: cell.row, column: cell.column, offset: sourceToDisplay(cell.map, source, bias) };
}
