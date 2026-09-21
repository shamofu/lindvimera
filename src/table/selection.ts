export interface CellPosition {
  row: number;
  column: number;
  /** A UTF-16 boundary in the editable (decoded) cell text. */
  offset: number;
}
