import { MapMode, type ChangeDesc, type Text } from "@codemirror/state";
import {
  decodeCell,
  displayToSource,
  encodeCell,
  parseMarkdownTable,
  sourceToDisplay,
  type MarkdownTable,
  type TableCell,
} from "../table/source";

export interface CellTarget {
  kind: "cell";
  tableFrom: number;
  tableTo: number;
  from: number;
  to: number;
  row: number;
  column: number;
  rows: number;
  columns: number;
  contentFrom: number;
  source: string;
  text: string;
}

export interface NavigationPosition {
  target: { kind: "body" } | CellTarget;
  offset: number;
  valid: boolean;
}

export interface NativeCellChange {
  target: CellTarget;
  text: string;
}

export function cellTarget(table: MarkdownTable, cell: TableCell): CellTarget {
  return {
    kind: "cell",
    tableFrom: table.from,
    tableTo: table.to,
    from: cell.from,
    to: cell.to,
    row: cell.row,
    column: cell.column,
    rows: table.rows.length,
    columns: table.rows[0].length,
    contentFrom: cell.content.from,
    source: cell.map.source,
    text: cell.map.text,
  };
}

export function sameTarget(
  a: NavigationPosition["target"],
  b: NavigationPosition["target"],
): boolean {
  return a.kind === "body"
    ? b.kind === "body"
    : b.kind === "cell" && a.tableFrom === b.tableFrom && a.from === b.from && a.to === b.to;
}

export function samePosition(a: NavigationPosition, b: NavigationPosition): boolean {
  return a.valid && b.valid && a.offset === b.offset && sameTarget(a.target, b.target);
}

export function copyPosition(position: NavigationPosition): NavigationPosition {
  return { ...position, target: { ...position.target } };
}

/** Recover the logical edit from a host's replacement of the complete cell value. */
export function mapReplacedText(before: string, after: string, offset: number): number | null {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  if (offset < start) return offset;
  if (offset >= oldEnd) return offset + newEnd - oldEnd;
  return null;
}

function mapBoundary(changes: ChangeDesc, position: number, start: boolean): number {
  let replacement = false;
  changes.iterChangedRanges((from, to) => {
    if (from !== to && (start ? from === position : to === position)) replacement = true;
  });
  return changes.mapPos(position, replacement ? (start ? -1 : 1) : start ? 1 : -1);
}

/** Parent serialization can replace an entire table while a precise native edit is known. */
export function mapParentPosition(
  position: NavigationPosition,
  changes: ChangeDesc,
  doc: Text,
  nativeChanges: readonly NativeCellChange[],
): void {
  if (!position.valid) return;
  if (position.target.kind === "body") {
    const offset = changes.mapPos(position.offset, 1, MapMode.TrackDel);
    if (offset === null) position.valid = false;
    else position.offset = offset;
    return;
  }
  const old = position.target;
  const tableFrom = mapBoundary(changes, old.tableFrom, true);
  const tableTo = mapBoundary(changes, old.tableTo, false);
  try {
    const table = parseMarkdownTable(doc.sliceString(tableFrom, tableTo), tableFrom);
    const native = nativeChanges.find(
      (change) =>
        change.target.tableFrom === old.tableFrom && change.target.tableTo === old.tableTo,
    );
    const nativeCell = native && table.rows[native.target.row]?.[native.target.column];
    // The host may adjust all column padding in the same serialization transaction.
    const mirrored =
      !!nativeCell &&
      nativeCell.map.text === native.text.trim() &&
      table.rows.length === old.rows &&
      table.rows[0].length === old.columns;
    const from = changes.mapPos(old.from, 1, MapMode.TrackDel);
    const to = changes.mapPos(old.to, -1, MapMode.TrackDel);
    let cell = table.rows
      .flat()
      .find((candidate) => candidate.from === from && candidate.to === to);
    if (!cell && mirrored) cell = table.rows[old.row]?.[old.column];
    if (!cell) {
      position.valid = false;
      return;
    }
    if (mirrored && native && sameTarget(old, native.target)) {
      const encoded = encodeCell(native.text);
      const raw = doc.sliceString(cell.from, cell.to);
      const index = raw.indexOf(encoded);
      if (index < 0) throw new Error("Native text does not match source");
      cell = {
        ...cell,
        content: { from: cell.from + index, to: cell.from + index + encoded.length },
        map: decodeCell(encoded, cell.from + index),
      };
      // The native ViewUpdate has already mapped the logical offset exactly once.
    } else {
      const source = displayToSource(
        decodeCell(old.source, old.contentFrom),
        Math.min(position.offset, old.text.length),
      );
      const mapped = changes.mapPos(source, 1, MapMode.TrackDel);
      let replacedContent = false;
      changes.iterChangedRanges((start, end) => {
        if (start <= old.contentFrom && end >= old.contentFrom + old.source.length)
          replacedContent = true;
      });
      const offset =
        !replacedContent &&
        mapped !== null &&
        mapped >= cell.content.from &&
        mapped <= cell.content.to
          ? sourceToDisplay(cell.map, mapped)
          : mapReplacedText(old.text, cell.map.text, position.offset);
      if (offset === null) {
        position.valid = false;
        return;
      }
      position.offset = offset;
    }
    position.target = cellTarget(table, cell);
    position.offset = Math.min(position.offset, cell.map.text.length);
  } catch {
    position.valid = false;
  }
}
