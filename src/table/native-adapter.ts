import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { decodeCell, parseMarkdownTable, TableSourceError } from "./source";
import type { MarkdownTable, TableCell } from "./source";
import type { CellPosition } from "./selection";
import { cellPosition } from "./motion";

type UnknownRecord = Record<string, unknown>;

interface NativeCell {
  row: number;
  col: number;
  text: string;
  table: NativeTable;
  el?: HTMLElement;
  getAbsoluteOffsets(): { start: number; end: number; textStart: number; textEnd: number };
}

interface NativeTable {
  start: number;
  end: number;
  rows: NativeCell[][];
  editor: NativeEditMode;
  getCellAt(row: number, column: number): NativeCell | null;
  deselectCells(): void;
}

interface NativeCellEditor {
  cell: NativeCell;
  table: NativeTable;
  cm: EditorView;
}

interface NativeEditMode {
  cm: EditorView;
  tableCell: NativeCellEditor | null;
  destroyTableCell(): void;
  editTableCell(table: NativeTable, cell: NativeCell): NativeCellEditor;
}

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function cmView(value: unknown): value is EditorView {
  return (
    record(value) &&
    typeof value.dispatch === "function" &&
    typeof value.focus === "function" &&
    record(value.state) &&
    record(value.state.doc) &&
    typeof value.state.doc.sliceString === "function" &&
    record(value.contentDOM) &&
    record(value.state.selection)
  );
}

function editMode(value: unknown): value is NativeEditMode {
  return (
    record(value) &&
    cmView(value.cm) &&
    typeof value.destroyTableCell === "function" &&
    typeof value.editTableCell === "function"
  );
}

function nativeCell(value: unknown): value is NativeCell {
  return (
    record(value) &&
    Number.isInteger(value.row) &&
    Number.isInteger(value.col) &&
    typeof value.text === "string" &&
    typeof value.getAbsoluteOffsets === "function"
  );
}

function cellEditor(value: unknown): value is NativeCellEditor {
  if (!record(value) || !nativeCell(value.cell) || !cmView(value.cm) || !record(value.table))
    return false;
  const table = value.table;
  return (
    Object.is(value.cell.table, table) &&
    Number.isInteger(table.start) &&
    Number.isInteger(table.end) &&
    Array.isArray(table.rows) &&
    typeof table.getCellAt === "function" &&
    typeof table.deselectCells === "function"
  );
}

export type NativeTableResolution =
  | { supported: true; context: NativeTableContext }
  | { supported: false; reason: string };

/** Lightweight lookup during native transactions, before source synchronization. */
export function nativeInputView(owner: unknown, parent: EditorView): EditorView | undefined {
  if (!editMode(owner) || owner.cm !== parent) return;
  const input = owner.tableCell;
  if (cellEditor(input) && input.table.editor === owner) return input.cm;
}

/** Stable coordinates also identify a cell when Obsidian recreates its editor. */
export function nativeCellIdentity(owner: unknown, parent: EditorView): string | undefined {
  if (!editMode(owner) || owner.cm !== parent) return;
  const input = owner.tableCell;
  if (cellEditor(input) && input.table.editor === owner)
    return `${input.table.start}:${input.cell.row}:${input.cell.col}`;
}

/** Unlike snapshot(), this also works during a cell's update before parent serialization. */
export function nativeCellCoordinates(
  owner: unknown,
  parent: EditorView,
):
  | { tableFrom: number; tableTo: number; from: number; to: number; row: number; column: number }
  | undefined {
  if (!editMode(owner) || owner.cm !== parent || !cellEditor(owner.tableCell)) return;
  const { table, cell } = owner.tableCell;
  if (table.editor !== owner) return;
  const range = cell.getAbsoluteOffsets();
  return {
    tableFrom: table.start,
    tableTo: table.end,
    from: range.start,
    to: range.end,
    row: cell.row,
    column: cell.col,
  };
}

/** Resolve a known source table even when no cell is currently open. */
export function resolveNativeTableAt(
  owner: unknown,
  parent: EditorView,
  from: number,
  to: number,
): NativeTableResolution {
  if (!editMode(owner) || owner.cm !== parent)
    return { supported: false, reason: "Native table editor API is unavailable." };
  const candidates: unknown[] = [owner.tableCell?.table];
  for (const provider of parent.state.facet(EditorView.decorations)) {
    const decorations = typeof provider === "function" ? provider(parent) : provider;
    decorations.between(from, to, (_from, _to, decoration) => {
      const spec: unknown = decoration.spec;
      if (record(spec)) candidates.push(spec.widget);
    });
  }
  for (const candidate of candidates) {
    if (
      !record(candidate) ||
      candidate.editor !== owner ||
      candidate.start !== from ||
      candidate.end !== to ||
      !Array.isArray(candidate.rows) ||
      typeof candidate.getCellAt !== "function" ||
      typeof candidate.deselectCells !== "function"
    )
      continue;
    try {
      const context = new NativeTableContext(owner, candidate as unknown as NativeTable);
      context.snapshot();
      return { supported: true, context };
    } catch {
      // Offscreen widgets may not have materialized their rows yet.
    }
  }
  return { supported: false, reason: "The marked table is not available in Live Preview." };
}

/** Closing a native surface is required before restoring a source/body cursor. */
export function focusNativeBody(owner: unknown, parent: EditorView, offset: number): void {
  if (editMode(owner) && owner.cm === parent && owner.tableCell) {
    owner.tableCell.table.deselectCells();
    owner.destroyTableCell();
  }
  parent.dispatch({
    selection: { anchor: Math.max(0, Math.min(offset, parent.state.doc.length)) },
    annotations: Transaction.addToHistory.of(false),
    scrollIntoView: true,
  });
  parent.focus();
}

export interface NativeRestorePosition {
  tableFrom: number;
  tableTo: number;
  from: number;
  to: number;
  offset: number;
  linewise: boolean;
}

function renderStep(parent: EditorView): Promise<void> {
  return new Promise((resolve) => {
    const win = parent.dom.ownerDocument.defaultView!;
    const frame = win.requestAnimationFrame(() => {
      win.clearTimeout(timer);
      resolve();
    });
    const timer = win.setTimeout(() => {
      win.cancelAnimationFrame(frame);
      resolve();
    }, 50);
  });
}

/** Rendering, opening and verifying a native target stay behind the host adapter. */
export async function restoreNativeCell(
  owner: () => unknown,
  parent: EditorView,
  position: () => NativeRestorePosition,
  check: () => void,
): Promise<void> {
  check();
  let target = position();
  // A retained, fully materialized table can still be outside the viewport.
  parent.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
  let result: NativeTableResolution = {
    supported: false,
    reason: "The marked table is not rendered.",
  };
  for (let attempt = 0; attempt < 12 && !result.supported; attempt++) {
    await renderStep(parent);
    check();
    target = position();
    result = resolveNativeTableAt(owner(), parent, target.tableFrom, target.tableTo);
  }
  check();
  if (!result.supported) throw new TableSourceError(result.reason);
  const table = result.context.snapshot();
  const cell = table.rows
    .flat()
    .find((candidate) => candidate.from === target.from && candidate.to === target.to);
  if (!cell) throw new TableSourceError("移動先のセルは削除されています。");
  if (target.offset < 0 || target.offset > cell.map.text.length)
    throw new TableSourceError("移動先のセル座標は変更されています。");
  const view = result.context.focus({ row: cell.row, column: cell.column, offset: target.offset });
  const line = view.state.doc.lineAt(target.offset);
  const offset = target.linewise
    ? line.from + (line.text.match(/^\s*/u)?.[0].length ?? 0)
    : target.offset;
  if (offset !== target.offset)
    view.dispatch({
      selection: { anchor: offset },
      annotations: Transaction.addToHistory.of(false),
    });
  const cellBox = view.dom.getBoundingClientRect();
  const viewport = parent.scrollDOM.getBoundingClientRect();
  if (
    cellBox.top < viewport.top ||
    cellBox.bottom > viewport.bottom ||
    cellBox.left < viewport.left ||
    cellBox.right > viewport.right
  )
    view.dom.scrollIntoView({ block: "nearest", inline: "nearest" });
  await renderStep(parent);
  check();
  const active = resolveNativeTable(owner(), parent);
  if (!active.supported) throw new TableSourceError(active.reason);
  const current = active.context.position();
  const input = active.context.cellView;
  if (
    !input ||
    current.row !== cell.row ||
    current.column !== cell.column ||
    current.offset !== offset ||
    input.state.doc.toString() !== cell.map.text
  )
    throw new TableSourceError("移動先のセルとカーソル位置を確認できません。");
}

/**
 * Feature detection is deliberately local to the supplied editor owner. The
 * caller passes MarkdownView.editMode (or the equivalent embedded editor) and
 * the originating CM view. Never resolve via app.workspace.activeLeaf.
 */
export function resolveNativeTable(
  owner: unknown,
  originatingView?: EditorView,
): NativeTableResolution {
  if (!editMode(owner))
    return { supported: false, reason: "Native table editor API is unavailable." };
  const editor = owner.tableCell;
  if (!cellEditor(editor) || editor.table.editor !== owner) {
    return { supported: false, reason: "Focus a Live Preview table cell first." };
  }
  if (originatingView && originatingView !== owner.cm && originatingView !== editor.cm) {
    return { supported: false, reason: "The originating editor belongs to a different pane." };
  }
  try {
    const context = new NativeTableContext(owner, editor.table);
    context.snapshot();
    return { supported: true, context };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : "Native table compatibility check failed.",
    };
  }
}

/** Only this module knows Obsidian's unpublished table object shape. */
export class NativeTableContext {
  constructor(
    private readonly owner: NativeEditMode,
    private readonly table: NativeTable,
  ) {}

  get parent(): EditorView {
    return this.owner.cm;
  }

  get cellView(): EditorView | null {
    const active = this.owner.tableCell;
    return active?.table === this.table ? active.cm : null;
  }

  get currentCell(): { row: number; column: number } | null {
    const active = this.owner.tableCell;
    return active?.table === this.table ? { row: active.cell.row, column: active.cell.col } : null;
  }

  snapshot(): MarkdownTable {
    const { parent, table } = this;
    if (
      table.editor !== this.owner ||
      table.start < 0 ||
      table.end > parent.state.doc.length ||
      table.start > table.end
    ) {
      throw new TableSourceError("The native table no longer belongs to this document.");
    }
    const source = parent.state.doc.sliceString(table.start, table.end);
    const model = parseMarkdownTable(source, table.start);
    if (table.rows.length !== model.rows.length)
      throw new TableSourceError("Native/source table row counts disagree.");
    const rows: TableCell[][] = [];
    for (let row = 0; row < table.rows.length; row++) {
      const nativeRow = table.rows[row];
      const modelRow = model.rows[row];
      if (!Array.isArray(nativeRow) || nativeRow.length !== modelRow.length) {
        throw new TableSourceError("Native/source table columns disagree.");
      }
      rows.push(
        nativeRow.map((cell, column) => {
          if (
            !nativeCell(cell) ||
            cell.table !== table ||
            cell.row !== row ||
            cell.col !== column
          ) {
            throw new TableSourceError("Native cell identity is unsupported.");
          }
          const range = cell.getAbsoluteOffsets();
          const parsed = modelRow[column];
          if (
            ![range.start, range.end, range.textStart, range.textEnd].every(Number.isInteger) ||
            range.start !== parsed.from ||
            range.end !== parsed.to ||
            range.textStart < range.start ||
            range.textEnd > range.end ||
            range.textEnd < range.textStart ||
            parent.state.doc.sliceString(range.textStart, range.textEnd) !== cell.text
          ) {
            throw new TableSourceError("Native/source cell offsets disagree; editing was stopped.");
          }
          const map = decodeCell(cell.text, range.textStart);
          const active = this.owner.tableCell;
          if (active?.cell === cell && active.cm.state.doc.toString() !== map.text) {
            throw new TableSourceError("Cell input has not synchronized with its parent document.");
          }
          return { ...parsed, content: { from: range.textStart, to: range.textEnd }, map };
        }),
      );
    }
    return { ...model, rows };
  }

  position(): CellPosition {
    const model = this.snapshot();
    const current = this.currentCell;
    return current && this.cellView
      ? { ...current, offset: this.cellView.state.selection.main.head }
      : cellPosition(model, this.parent.state.selection.main.head);
  }

  focus(position: CellPosition): EditorView {
    const cell = this.table.getCellAt(position.row, position.column);
    if (!cell) throw new TableSourceError("The destination cell no longer exists.");
    const input = this.owner.editTableCell(this.table, cell);
    const offset = Math.max(0, Math.min(position.offset, input.cm.state.doc.length));
    input.cm.dispatch({
      selection: { anchor: offset },
      annotations: Transaction.addToHistory.of(false),
    });
    input.cm.focus();
    return input.cm;
  }

  canLeave(direction: "before" | "after"): boolean {
    const model = this.snapshot();
    const doc = this.parent.state.doc;
    const line = doc.lineAt(direction === "before" ? model.from : model.to);
    return direction === "before" ? line.number > 1 : line.number < doc.lines;
  }

  leave(direction: "before" | "after"): void {
    if (!this.canLeave(direction)) return;
    const model = this.snapshot();
    this.closeCell();
    const doc = this.parent.state.doc;
    const line = doc.lineAt(direction === "before" ? model.from : model.to);
    const target = direction === "before" ? line.number - 1 : line.number + 1;
    if (target >= 1 && target <= doc.lines) {
      this.parent.dispatch({ selection: { anchor: doc.line(target).from } });
      this.parent.focus();
    }
  }

  private closeCell(): void {
    const current = this.owner.tableCell;
    if (current && current.table !== this.table)
      throw new TableSourceError("The table input changed; retry the operation.");
    this.table.deselectCells();
    if (current) this.owner.destroyTableCell();
  }
}
