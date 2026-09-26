import { parser, TaskList } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import type { TextRange } from "./ranges";

export interface MarkdownBlock extends TextRange {
  /** A nested marker on its parent's line does not own the parent prefix. */
  containsFrom: number;
  inner: TextRange;
  parent?: number;
  depth: number;
  /** Source heading level (1–6), independent of the number of existing ancestors. */
  headingLevel?: number;
}

export interface MarkdownBlocks {
  sections: MarkdownBlock[];
  listItems: MarkdownBlock[];
}

export interface BlockSelection extends TextRange {
  linewise: boolean;
}

interface SourceLine extends TextRange {
  next: number;
  blank: boolean;
}

const blockParser = parser.configure(TaskList);

/** Mask YAML without changing the parser's UTF-16 source coordinates. */
function withoutFrontmatter(text: string): string {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return text;
  for (let index = 0; index < lines.length; index++) {
    const end = index > 0 && /^(---|\.\.\.)\s*$/.test(lines[index]);
    lines[index] = " ".repeat(lines[index].length);
    if (end) break;
  }
  return lines.join("\n");
}

/** Parse block ownership independently of Obsidian's viewport-limited token tree. */
export function indexMarkdownBlocks(text: string): MarkdownBlocks {
  const lines: SourceLine[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const to = offset + line.length;
    lines.push({ from: offset, to, next: Math.min(text.length, to + 1), blank: !line.trim() });
    offset = to + 1;
  }
  const lineAt = (position: number): number => {
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lines[middle].from <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const lastContentLine = (from: number, to: number): number => {
    const first = lineAt(from);
    let last = lineAt(Math.max(from, to - 1));
    while (last > first && lines[last].blank) last--;
    return last;
  };
  const tree = blockParser.parse(withoutFrontmatter(text));
  const headings: { from: number; body: number; level: number }[] = [];
  const listItems: MarkdownBlock[] = [];
  const visit = (node: SyntaxNode, parent?: number): void => {
    if (node.name === "Blockquote") return;
    if (node.name === "ListItem") {
      const marker = node.getChild("ListMark");
      if (!marker) return;
      const first = lineAt(node.from);
      const last = lastContentLine(node.from, node.to);
      let after = last + 1;
      while (after < lines.length && lines[after].blank) after++;
      const checkbox = node.getChild("Task")?.getChild("TaskMarker");
      let content = marker.to;
      while (content < lines[first].to && /[ \t]/.test(text[content])) content++;
      // A loose item's later paragraph may also parse as Task. Only the
      // checkbox immediately following this item's marker belongs to its prefix.
      if (checkbox?.from === content) {
        content = checkbox.to;
        while (content < lines[first].to && /[ \t]/.test(text[content])) content++;
      }
      const index = listItems.length;
      listItems.push({
        from: lines[first].from,
        containsFrom: text.slice(lines[first].from, node.from).trim()
          ? node.from
          : lines[first].from,
        to: lines[after - 1].next,
        inner: { from: content, to: Math.max(content, lines[last].to) },
        parent,
        depth: parent === undefined ? 0 : listItems[parent].depth + 1,
      });
      parent = index;
    }
    // Inline nodes and code/HTML blocks cannot introduce list items.
    if (!["Document", "BulletList", "OrderedList", "ListItem"].includes(node.name)) return;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (node.name === "Document" && /^(?:ATX|Setext)Heading[1-6]$/.test(child.name)) {
        headings.push({
          from: lines[lineAt(child.from)].from,
          body: lines[lineAt(Math.max(child.from, child.to - 1))].next,
          level: Number(child.name.at(-1)),
        });
      } else visit(child, parent);
    }
  };
  visit(tree.topNode);
  const sections: MarkdownBlock[] = [];
  const ancestors: number[] = [];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    while (ancestors.length && headings[ancestors.at(-1)!].level >= heading.level) {
      sections[ancestors.pop()!].to = heading.from;
    }
    const parent = ancestors.at(-1);
    sections.push({
      from: heading.from,
      containsFrom: heading.from,
      to: text.length,
      inner: { from: heading.body, to: text.length },
      parent,
      depth: ancestors.length,
      headingLevel: heading.level,
    });
    ancestors.push(index);
  }
  for (const section of sections) {
    let first = lineAt(section.inner.from);
    const last = lastContentLine(section.inner.from, section.to);
    while (first <= last && lines[first].blank) first++;
    section.inner =
      section.inner.from >= section.to || first > last
        ? { from: section.inner.from, to: section.inner.from }
        : { from: lines[first].from, to: lines[last].next };
  }
  return { sections, listItems };
}

/** Counts climb actual parents; they never extend into adjacent siblings. */
export function markdownBlockObject(
  blocks: MarkdownBlocks,
  textLength: number,
  offset: number,
  kind: "h" | "L",
  inner: boolean,
  count = 1,
): BlockSelection | undefined {
  const objects = kind === "h" ? blocks.sections : blocks.listItems;
  let selected: MarkdownBlock | undefined;
  for (const object of objects) {
    if (
      offset >= object.containsFrom &&
      (offset < object.to || (offset === textLength && object.to === textLength)) &&
      (!selected || object.depth > selected.depth)
    )
      selected = object;
  }
  for (let repeat = 1; selected && repeat < count; repeat++)
    selected = selected.parent === undefined ? undefined : objects[selected.parent];
  if (!selected) return;
  const range = inner ? selected.inner : selected;
  if (range.to <= range.from) return;
  return { from: range.from, to: range.to, linewise: kind === "h" || !inner };
}
