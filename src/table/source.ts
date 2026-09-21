/** Source offsets are UTF-16 offsets, as in CodeMirror. Ranges are half-open. */
export interface SourceRange {
  from: number;
  to: number;
}

export interface CellSourceMap {
  source: string;
  text: string;
  /** Every displayed UTF-16 boundary maps to an absolute source boundary. */
  boundaries: readonly number[];
}

export interface TableCell extends SourceRange {
  row: number;
  column: number;
  content: SourceRange;
  map: CellSourceMap;
}

export interface MarkdownTable extends SourceRange {
  source: string;
  rows: readonly (readonly TableCell[])[];
  separator: SourceRange;
  alignments: readonly ("left" | "center" | "right" | null)[];
}

export class TableSourceError extends Error {}

/**
 * Decode the editable cell text, not rendered Markdown/HTML. Code spans and
 * wikilinks remain Markdown. This follows Obsidian 1.13.7's cell input format:
 * one backslash is removed from an odd run before |; <br> outside code becomes
 * a newline. Other HTML, entities, and Markdown escapes remain untouched.
 */
export function decodeCell(source: string, sourceOffset = 0): CellSourceMap {
  const codeRanges = Array.from(source.matchAll(/(`+)[^`]+\1/g), (match) => ({
    from: match.index,
    to: match.index + match[0].length,
  }));
  const transforms: { from: number; to: number; text: string }[] = [];
  for (const match of source.matchAll(/(\\+\||<br>)/gi)) {
    const token = match[0];
    const from = match.index;
    const to = from + token.length;
    if (token.toLowerCase() === "<br>") {
      if (!codeRanges.some((range) => range.from < from && range.to > to)) {
        transforms.push({ from, to, text: "\n" });
      }
    } else if ((token.length - 1) % 2 === 1) {
      transforms.push({ from: to - 2, to, text: "|" });
    }
  }

  let text = "";
  const boundaries = [sourceOffset];
  let cursor = 0;
  const appendLiteral = (until: number) => {
    while (cursor < until) {
      text += source[cursor];
      boundaries.push(sourceOffset + ++cursor);
    }
  };
  for (const transform of transforms) {
    appendLiteral(transform.from);
    text += transform.text;
    cursor = transform.to;
    boundaries.push(sourceOffset + cursor);
  }
  appendLiteral(source.length);
  return { source, text, boundaries };
}

/** Encode a complete editable cell value using Obsidian's native conventions. */
export function encodeCell(text: string): string {
  return text.replace(/\r?\n|\\*\|/g, (token) => {
    if (token.endsWith("|")) {
      return (token.length - 1) % 2 === 1 ? token : `${token.slice(0, -1)}\\|`;
    }
    return "<br>";
  });
}

export function displayToSource(map: CellSourceMap, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset >= map.boundaries.length) {
    throw new TableSourceError("Cell position is outside its editable text.");
  }
  return map.boundaries[offset];
}

export function sourceToDisplay(map: CellSourceMap, offset: number, bias: -1 | 1 = 1): number {
  const start = map.boundaries[0];
  const end = map.boundaries[map.boundaries.length - 1];
  if (!Number.isInteger(offset) || offset < start || offset > end) {
    throw new TableSourceError("Source position is outside its cell.");
  }
  let low = 0;
  let high = map.boundaries.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = map.boundaries[middle];
    if (value === offset) return middle;
    if (value < offset) low = middle + 1;
    else high = middle - 1;
  }
  return bias === -1 ? high : low;
}

function splitRow(line: string, offset: number, row: number): TableCell[] {
  const delimiters: number[] = [];
  let slashes = 0;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === "|" && slashes % 2 === 0) delimiters.push(index);
    slashes = character === "\\" ? slashes + 1 : 0;
  }
  if (delimiters.length === 0) throw new TableSourceError("Table row has no cell separator.");
  const leading = /^[ \t]*$/.test(line.slice(0, delimiters[0]));
  const trailing = /^[ \t]*$/.test(line.slice(delimiters[delimiters.length - 1] + 1));
  const edges = [-1, ...delimiters, line.length];
  const cells: TableCell[] = [];
  for (let index = leading ? 1 : 0; index < edges.length - (trailing ? 2 : 1); index++) {
    const from = edges[index] + 1;
    const to = edges[index + 1];
    const raw = line.slice(from, to);
    const leftPadding = raw.match(/^[ \t]*/)?.[0].length ?? 0;
    const trimmed = raw.trim();
    const content = {
      from: offset + from + leftPadding,
      to: offset + from + leftPadding + trimmed.length,
    };
    cells.push({
      row,
      column: cells.length,
      from: offset + from,
      to: offset + to,
      content,
      map: decodeCell(trimmed, content.from),
    });
  }
  return cells;
}

/**
 * Parse an exact, rectangular table slice. Callers locate table nodes using the
 * host's syntax/native widget. Never scan arbitrary Markdown for apparent pipes.
 * Reject malformed rows rather than invent source offsets for implicit cells.
 */
export function parseMarkdownTable(source: string, sourceOffset = 0): MarkdownTable {
  if (!Number.isInteger(sourceOffset) || sourceOffset < 0)
    throw new TableSourceError("Invalid table offset.");
  const lines = source.replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length < 2) throw new TableSourceError("A table needs a header and a separator.");
  let offset = sourceOffset;
  const parsed = lines.map((line, index) => {
    const cells = splitRow(line, offset, index === 0 ? 0 : index - 1);
    offset +=
      line.length +
      (source.slice(
        offset - sourceOffset + line.length,
        offset - sourceOffset + line.length + 2,
      ) === "\r\n"
        ? 2
        : 1);
    return cells;
  });
  const columns = parsed[0].length;
  if (columns === 0 || parsed.some((row) => row.length !== columns)) {
    throw new TableSourceError("A table must have explicit, equal-width rows.");
  }
  const alignments = parsed[1].map((cell) => {
    const token = cell.map.source;
    if (!/^:?-+:?$/.test(token)) throw new TableSourceError("Invalid table separator.");
    if (token.startsWith(":")) return token.endsWith(":") ? "center" : "left";
    return token.endsWith(":") ? "right" : null;
  });
  const separatorStart =
    sourceOffset + lines[0].length + (source[lines[0].length] === "\r" ? 2 : 1);
  return {
    source,
    from: sourceOffset,
    to: sourceOffset + source.length,
    rows: [parsed[0], ...parsed.slice(2)],
    separator: { from: separatorStart, to: separatorStart + lines[1].length },
    alignments,
  };
}
