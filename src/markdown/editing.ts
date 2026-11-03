import { parser, Table, TaskList } from "@lezer/markdown";
import type { SyntaxNode, Tree } from "@lezer/common";

interface SourceRow {
  from: number;
  to: number;
  blocked: boolean;
  content: number;
  prefix?: string;
  transferredPrefix?: string;
  ancestors?: { from: number; to: number }[];
  item?: ListItem;
}
interface ListItem {
  from: number;
  to: number;
  markerFrom: number;
  markerTo: number;
  list: number;
  row: number;
  number?: number;
}
export interface MarkdownEditingIndex {
  text: string;
  /** This tree and the row contexts belong to one complete source revision. */
  tree: Tree;
  rows: SourceRow[];
  items: ListItem[];
}
export interface MarkdownLineEdit {
  changes: { from: number; to: number; insert: string }[];
  cursor: number;
}

const editingParser = parser.configure([TaskList, Table]);

function rowAt(rows: SourceRow[], position: number): number {
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (rows[middle].from <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Parse all physical rows once; syntax nodes distinguish prefixes from literal code. */
export function buildMarkdownEditingIndex(text: string): MarkdownEditingIndex {
  const rows: SourceRow[] = [];
  let position = 0;
  for (const value of text.split("\n")) {
    rows.push({ from: position, to: position + value.length, blocked: false, content: position });
    position += value.length + 1;
  }
  let frontmatterEnd = -1;
  if (text.slice(rows[0].from, rows[0].to).trim() === "---") {
    frontmatterEnd = rows.length - 1;
    for (let i = 1; i < rows.length; i++) {
      if (/^(?:---|\.\.\.)\s*$/.test(text.slice(rows[i].from, rows[i].to))) {
        frontmatterEnd = i;
        break;
      }
    }
    for (let i = 0; i <= frontmatterEnd; i++) rows[i].blocked = true;
  }
  // Masking preserves every UTF-16 coordinate, including astral Unicode in YAML.
  const parseText = rows
    .map((row, i) =>
      i <= frontmatterEnd ? " ".repeat(row.to - row.from) : text.slice(row.from, row.to),
    )
    .join("\n");
  const tree = editingParser.parse(parseText);
  const marks = new Map<number, { to: number; kind: string }>();
  const items: ListItem[] = [];
  let listId = 0;
  const visit = (node: SyntaxNode, list = -1): void => {
    if (["FencedCode", "CodeBlock", "Table"].includes(node.name)) {
      for (let i = rowAt(rows, node.from); i <= rowAt(rows, Math.max(node.from, node.to - 1)); i++)
        rows[i].blocked = true;
      return;
    }
    if (node.name === "BulletList" || node.name === "OrderedList") list = listId++;
    if (["ListMark", "QuoteMark", "HeaderMark"].includes(node.name))
      marks.set(node.from, { to: node.to, kind: node.name });
    if (node.name === "ListItem") {
      const mark = node.getChild("ListMark");
      if (mark) {
        const number = /^(\d+)[.)]$/.exec(text.slice(mark.from, mark.to));
        items.push({
          from: node.from,
          to: node.to,
          markerFrom: mark.from,
          markerTo: mark.to,
          list,
          row: rowAt(rows, mark.from),
          number: number ? Number(number[1]) : undefined,
        });
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, list);
  };
  visit(tree.topNode);
  const rowItems = new Map<number, ListItem>();
  // Range events avoid revisiting every descendant row once per ancestor item.
  const continuationEvents = new Int32Array(rows.length + 1);
  for (const item of items) {
    rowItems.set(item.row, item);
    const last = rowAt(rows, Math.max(item.from, item.to - 1));
    if (last > item.row) {
      continuationEvents[item.row + 1]++;
      continuationEvents[last + 1]--;
    }
  }
  let continuationDepth = 0;
  for (let rowNumber = 0; rowNumber < rows.length; rowNumber++) {
    continuationDepth += continuationEvents[rowNumber];
    const row = rows[rowNumber];
    if (row.blocked) continue;
    let at = row.from;
    const skipSpace = () => {
      while (at < row.to && /[ \t\r]/.test(text[at])) at++;
    };
    skipSpace();
    const listPrefixes: { from: number; to: number }[] = [];
    let structural = false;
    let quoteOrList = false;
    let prefixEnd = at;
    while (at < row.to) {
      const markFrom = at;
      const mark = marks.get(at);
      if (!mark) break;
      structural = true;
      if (mark.kind === "HeaderMark") {
        at = mark.to;
        skipSpace();
        break;
      }
      quoteOrList = true;
      at = mark.to;
      skipSpace();
      if (mark.kind === "ListMark") {
        // Only a checkbox immediately following a real list marker is a prefix.
        const task = /^\[[ xX]\](?:[ \t]+|$)/.exec(text.slice(at, row.to));
        if (task) at += task[0].length;
        listPrefixes.push({ from: markFrom, to: at });
      }
      prefixEnd = at;
    }
    row.content = at;
    row.item = rowItems.get(rowNumber);
    if (structural && quoteOrList) {
      row.prefix = text.slice(row.from, prefixEnd).replace(/\[[xX]\]/g, "[ ]");
      if (!/[ \t]$/.test(row.prefix)) row.prefix += " ";
      const ancestors = listPrefixes.filter(
        (range) => row.item && range.from < row.item.markerFrom,
      );
      if (ancestors.length) {
        row.transferredPrefix = row.prefix;
        row.ancestors = ancestors;
        for (const ancestor of ancestors) {
          const from = ancestor.from - row.from;
          const to = ancestor.to - row.from;
          row.prefix =
            row.prefix.slice(0, from) +
            row.prefix.slice(from, to).replace(/[^ \t]/g, " ") +
            row.prefix.slice(to);
        }
      }
    } else if (continuationDepth > 0) {
      const indent = text.slice(row.from, prefixEnd);
      if (indent) row.prefix = indent;
    }
  }
  return { text, tree, rows, items };
}

export function markdownContentStart(
  index: MarkdownEditingIndex,
  offset: number,
): number | undefined {
  const row = index.rows[rowAt(index.rows, Math.max(0, Math.min(offset, index.text.length)))];
  return row.blocked ? undefined : row.content;
}

/** Return original-coordinate changes; callers apply them together as one Vim insertion. */
export function markdownOpenLine(
  index: MarkdownEditingIndex,
  offset: number,
  after: boolean,
  renumber = true,
): MarkdownLineEdit | undefined {
  const { text, rows } = index;
  const rowIndex = rowAt(rows, Math.max(0, Math.min(offset, text.length)));
  const row = rows[rowIndex];
  if (row.blocked || row.prefix === undefined) return;
  let prefix = after ? row.prefix : (row.transferredPrefix ?? row.prefix);
  const changes: MarkdownLineEdit["changes"] = [];
  // O moves same-row ancestor markers onto the inserted row. Their original
  // positions become indentation so the existing content keeps its list parent.
  if (!after) {
    for (const ancestor of row.ancestors ?? [])
      changes.push({
        from: ancestor.from,
        to: ancestor.to,
        insert: text.slice(ancestor.from, ancestor.to).replace(/[^ \t]/g, " "),
      });
  }
  const columns = (from: number, to: number): number => {
    let column = 0;
    for (let at = from; at < to; at++) column += text[at] === "\t" ? 4 - (column % 4) : 1;
    return column;
  };
  const normalizedPadding = (item: ListItem): MarkdownLineEdit["changes"][number] | undefined => {
    const first = rows[item.row];
    let to = item.markerTo;
    while (to < first.to && /[ \t]/.test(text[to])) to++;
    if (!text.slice(item.markerTo, to).includes("\t")) return;
    // A changed marker must not change the tab's visual padding or turn
    // indented code into ordinary list content by crossing a tab stop.
    const width = columns(first.from, to) - columns(first.from, item.markerTo);
    return { from: item.markerTo, to, insert: " ".repeat(width) };
  };
  const adjustDescendants = (sibling: ListItem, delta: number): void => {
    if (!delta) return;
    const first = rows[sibling.row];
    const beforeMarker = text.slice(first.from, sibling.markerFrom);
    const quoteDepth = (beforeMarker.match(/>/g) ?? []).length;
    let firstAnchor = first.from;
    for (let q = 0; q < quoteDepth; q++) {
      firstAnchor = text.indexOf(">", firstAnchor) + 1;
      if (text[firstAnchor] === " " || text[firstAnchor] === "\t") firstAnchor++;
    }
    let markerContent = sibling.markerTo;
    while (markerContent < first.to && /[ \t]/.test(text[markerContent])) markerContent++;
    const markerColumn = columns(first.from, sibling.markerTo);
    const contentColumn = columns(first.from, markerContent);
    // CommonMark treats five or more columns after a list marker as one
    // padding column plus indented body content, rather than list padding.
    const contentIndent =
      contentColumn - markerColumn >= 5 || markerContent === first.to
        ? markerColumn + 1
        : contentColumn;
    const requiredIndent = contentIndent - columns(first.from, firstAnchor);
    for (let i = sibling.row + 1; i < rows.length && rows[i].from < sibling.to; i++) {
      const descendant = rows[i];
      let anchor = descendant.from;
      let valid = true;
      for (let q = 0; q < quoteDepth; q++) {
        while (anchor < descendant.to && /[ \t]/.test(text[anchor])) anchor++;
        if (text[anchor] !== ">") {
          valid = false;
          break;
        }
        anchor++;
        if (text[anchor] === " " || text[anchor] === "\t") anchor++;
      }
      if (!valid) continue;
      let end = anchor;
      while (end < descendant.to && /[ \t]/.test(text[end])) end++;
      const indent = text.slice(anchor, end);
      const width = columns(descendant.from, end) - columns(descendant.from, anchor);
      if (width < requiredIndent) continue;
      if (!indent.includes("\t")) {
        changes.push({
          from: anchor,
          to: anchor + Math.max(0, -delta),
          insert: " ".repeat(Math.max(0, delta)),
        });
      } else if (delta > 0) {
        changes.push({ from: end, to: end, insert: " ".repeat(delta) });
      } else {
        changes.push({ from: anchor, to: end, insert: " ".repeat(width + delta) });
      }
    }
  };
  const item = row.item;
  if (item?.number !== undefined && renumber) {
    const next = item.number + (after ? 1 : 0);
    const local = item.markerFrom - row.from;
    const insertedDelta = String(next).length - (item.markerTo - item.markerFrom - 1);
    if (insertedDelta) {
      const padding = normalizedPadding(item);
      if (padding)
        prefix =
          prefix.slice(0, padding.from - row.from) +
          padding.insert +
          prefix.slice(padding.to - row.from);
    }
    prefix = prefix.slice(0, local) + String(next) + prefix.slice(item.markerTo - row.from - 1);
    // Physical insertion places the old descendants beneath the new item.
    if (after) adjustDescendants(item, insertedDelta);
    let number = next + 1;
    for (const sibling of index.items) {
      if (
        sibling.list !== item.list ||
        sibling.markerFrom < item.markerFrom ||
        (after && sibling === item)
      )
        continue;
      const oldDigits = text.slice(sibling.markerFrom, sibling.markerTo - 1);
      const digits = String(number++);
      if (digits === oldDigits) continue;
      changes.push({ from: sibling.markerFrom, to: sibling.markerTo - 1, insert: digits });
      const delta = digits.length - oldDigits.length;
      if (!delta) continue;
      const padding = normalizedPadding(sibling);
      if (padding) changes.push(padding);
      adjustDescendants(sibling, delta);
    }
  }
  const insertion = after ? row.to : row.from;
  const insert = after ? "\n" + prefix : prefix + "\n";
  changes.push({ from: insertion, to: insertion, insert });
  changes.sort((a, b) => a.from - b.from || a.to - b.to);
  // Above-row insertion can share a coordinate with a numbered marker replacement.
  let cursor = insertion + (after ? 1 : 0) + prefix.length;
  for (const change of changes) {
    if (change.from < insertion) cursor += change.insert.length - (change.to - change.from);
  }
  return { changes, cursor };
}
