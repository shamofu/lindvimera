import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history } from "@codemirror/commands";
import { getCM, Vim } from "@replit/codemirror-vim";
import { editorSession, lindvimeraEditor } from "../../src/runtime/editor";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { NativeTableSession } from "../../src/table/session";
import type { CellPosition } from "../../src/table/selection";
import { decodeCell, encodeCell, parseMarkdownTable } from "../../src/table/source";

interface Cell {
  row: number;
  col: number;
  text: string;
  table: HostTable;
  el: HTMLElement;
  getAbsoluteOffsets(): { start: number; end: number; textStart: number; textEnd: number };
}
interface Input {
  cell: Cell;
  table: HostTable;
  cm: EditorView;
}
interface HostTable {
  start: number;
  end: number;
  rows: Cell[][];
  editor: NativeHostFixture;
  getCellAt(row: number, column: number): Cell | null;
  deselectCells(): void;
}

/** Only Obsidian's native boundary is simulated; production runtime, Vim and history run. */
export class NativeHostFixture {
  readonly cm: EditorView;
  readonly engine: NonNullable<ReturnType<typeof getCM>>;
  readonly session: NativeTableSession;
  readonly table: HostTable;
  readonly settings = { ...DEFAULT_SETTINGS, japanese: false };
  readonly nativeKeys: string[] = [];
  tableCell: Input | null = null;
  private syncing = false;

  constructor(
    source: string,
    private prefix = "",
    private suffix = "",
  ) {
    this.table = {
      start: prefix.length,
      end: prefix.length + source.length,
      rows: [],
      editor: this,
      getCellAt: (row, column) => this.table.rows[row]?.[column] ?? null,
      deselectCells() {},
    };
    this.rebuild(prefix + source + suffix);
    this.cm = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: prefix + source + suffix,
        extensions: [
          history(),
          EditorState.allowMultipleSelections.of(true),
          lindvimeraEditor({
            settings: () => this.settings,
            owner: () => this,
            error: (message) => {
              throw new Error(message);
            },
          }),
          keymap.of(defaultKeymap),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            this.rebuild(update.state.doc.toString());
            if (!this.syncing && this.tableCell) {
              const input = this.tableCell;
              const text = decodeCell(input.cell.text).text;
              this.syncing = true;
              input.cm.dispatch({
                changes: { from: 0, to: input.cm.state.doc.length, insert: text },
                selection: { anchor: Math.min(input.cm.state.selection.main.head, text.length) },
                annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
              });
              this.syncing = false;
            }
          }),
        ],
      }),
    });
    this.engine = getCM(this.cm)!;
    this.session = editorSession(this.cm)!.table;
    this.focus({ row: 1, column: 0, offset: 0 });
  }

  private rebuild(source: string): void {
    this.table.start = this.prefix.length;
    this.table.end = source.length - this.suffix.length;
    const model = parseMarkdownTable(
      source.slice(this.table.start, this.table.end),
      this.table.start,
    );
    this.table.rows = model.rows.map((row) =>
      row.map((cell) => ({
        row: cell.row,
        col: cell.column,
        text: cell.map.source,
        table: this.table,
        el: document.createElement("td"),
        getAbsoluteOffsets: () => ({
          start: cell.from,
          end: cell.to,
          textStart: cell.content.from,
          textEnd: cell.content.to,
        }),
      })),
    );
    const active = this.tableCell;
    if (active) {
      const next = this.table.getCellAt(active.cell.row, active.cell.col);
      if (next) {
        // Native editing distinguishes meaningful leading/trailing spaces from table padding.
        if (this.syncing) {
          const raw = model.rows[next.row]![next.col]!;
          const encoded = encodeCell(active.cm.state.doc.toString());
          const offset = source.slice(raw.from, raw.to).indexOf(encoded);
          if (offset >= 0 && encoded.length) {
            next.text = encoded;
            next.getAbsoluteOffsets = () => ({
              start: raw.from,
              end: raw.to,
              textStart: raw.from + offset,
              textEnd: raw.from + offset + encoded.length,
            });
          }
        }
        active.cell = next;
      }
    }
  }

  editTableCell(table: HostTable, cell: Cell): Input {
    if (this.tableCell?.cell.row === cell.row && this.tableCell.cell.col === cell.col)
      return this.tableCell;
    this.destroyTableCell();
    const input: Input = { cell, table, cm: null as unknown as EditorView };
    input.cm = new EditorView({
      parent: this.cm.dom,
      state: EditorState.create({
        doc: decodeCell(cell.text).text,
        extensions: [
          keymap.of([
            { key: "Tab", run: () => this.nativeMove("Tab") },
            { key: "Shift-Tab", run: () => this.nativeMove("Shift-Tab") },
            { key: "Enter", run: () => this.nativeMove("Enter") },
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (this.syncing || (!update.docChanged && !update.selectionSet)) return;
            const range = input.cell.getAbsoluteOffsets();
            const text = update.state.doc.toString();
            const encoded = encodeCell(text);
            const anchor =
              range.textStart + encodeCell(text.slice(0, update.state.selection.main.head)).length;
            this.syncing = true;
            this.cm.dispatch({
              changes: update.docChanged
                ? { from: range.textStart, to: range.textEnd, insert: encoded }
                : undefined,
              selection: EditorSelection.cursor(anchor),
              annotations: Transaction.userEvent.of(update.docChanged ? "input.type" : "select"),
            });
            this.syncing = false;
          }),
        ],
      }),
    });
    this.tableCell = input;
    input.cm.focus();
    return input;
  }

  private nativeMove(key: string): boolean {
    this.nativeKeys.push(key);
    const cell = this.tableCell!.cell;
    const width = this.table.rows[0]!.length;
    const index = cell.row * width + cell.col;
    const target = Math.max(0, index + (key === "Shift-Tab" ? -1 : key === "Enter" ? width : 1));
    if (target >= this.table.rows.length * width) {
      this.cm.dispatch({
        changes: {
          from: this.table.end,
          insert: `\n|${Array.from({ length: width }, () => " ").join("|")}|`,
        },
        annotations: Transaction.userEvent.of("input.type"),
      });
    }
    this.focus({ row: Math.floor(target / width), column: target % width, offset: 0 });
    return true;
  }

  destroyTableCell(): void {
    const current = this.tableCell;
    if (current) {
      current.cm.destroy();
      current.cm.dom.remove();
    }
    this.tableCell = null;
  }

  focus(position: CellPosition): void {
    const input = this.editTableCell(
      this.table,
      this.table.getCellAt(position.row, position.column)!,
    );
    input.cm.dispatch({ selection: { anchor: position.offset } });
    this.session?.syncTarget();
  }

  regenerate(): void {
    const input = this.tableCell!;
    const position = {
      row: input.cell.row,
      column: input.cell.col,
      offset: input.cm.state.selection.main.head,
    };
    this.destroyTableCell();
    this.focus(position);
  }

  keys(values: string[] | string): void {
    for (const key of typeof values === "string" ? (values.match(/<[^>]+>|./gu) ?? []) : values) {
      this.session.syncTarget();
      this.engine.operation(() => Vim.handleKey(this.engine, key, "user"));
    }
  }

  dom(values: string): void {
    for (const value of values.match(/<[^>]+>|./gu) ?? []) {
      const input = this.tableCell?.cm ?? this.cm;
      const event = keyEvent(value);
      input.contentDOM.dispatchEvent(event);
      if (!event.defaultPrevented && value.length === 1) this.insert(value);
    }
  }

  insert(text: string): void {
    const input = this.tableCell?.cm ?? this.cm;
    input.contentDOM.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: text,
        bubbles: true,
        cancelable: true,
      }),
    );
    input.dispatch(input.state.replaceSelection(text), {
      annotations: Transaction.userEvent.of("input.type"),
    });
  }

  values(): string[][] {
    const source = this.cm.state.doc.sliceString(this.table.start, this.table.end);
    return parseMarkdownTable(source).rows.map((row) => row.map((cell) => cell.map.text));
  }

  destroy(): void {
    this.destroyTableCell();
    this.cm.destroy();
    this.cm.dom.remove();
  }
}

export function keyEvent(value: string): KeyboardEvent {
  const named: Record<string, string> = { Esc: "Escape", CR: "Enter", BS: "Backspace" };
  const token = value.startsWith("<") ? value.slice(1, -1) : value;
  const pieces = value.startsWith("<") ? token.split("-") : ["", token];
  const key = pieces.at(-1)!;
  return new KeyboardEvent("keydown", {
    key: named[key] ?? key,
    ctrlKey: pieces.includes("C"),
    shiftKey: pieces.includes("S"),
    altKey: pieces.includes("A"),
    bubbles: true,
    cancelable: true,
  });
}
