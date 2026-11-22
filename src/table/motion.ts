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

export function adjacentCellPosition(
  table: MarkdownTable,
  current: Pick<CellPosition, "row" | "column">,
  forward: boolean,
  count = 1,
): CellPosition | undefined {
  const columns = table.rows[0]?.length ?? 0;
  if (!table.rows.length || !columns) return undefined;
  const index = current.row * columns + current.column;
  const next = Math.max(
    0,
    Math.min(table.rows.length * columns - 1, index + (forward ? 1 : -1) * Math.max(1, count)),
  );
  return { row: Math.floor(next / columns), column: next % columns, offset: 0 };
}
