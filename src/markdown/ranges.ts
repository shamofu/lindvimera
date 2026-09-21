export interface TextRange {
  from: number;
  to: number;
}

export interface MarkdownObject extends TextRange {
  inner: TextRange;
  alternateInner?: TextRange;
  kind: "*" | "_" | "`" | "l" | "C";
}

interface Structure {
  position: number;
  indent: number;
}

export interface MarkdownIndex {
  headings: Structure[];
  lists: Structure[];
  objects: MarkdownObject[];
}

function escaped(text: string, offset: number): boolean {
  let count = 0;
  while (offset > 0 && text[--offset] === "\\") count++;
  return count % 2 === 1;
}

function inlineObjects(line: string, offset: number): MarkdownObject[] {
  const result: MarkdownObject[] = [];
  const code: TextRange[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "`" || escaped(line, i)) continue;
    let width = 1;
    while (line[i + width] === "`") width++;
    const delimiter = "`".repeat(width);
    let end = i + width;
    while ((end = line.indexOf(delimiter, end)) >= 0) {
      if (line[end - 1] !== "`" && line[end + width] !== "`") break;
      end += width;
    }
    if (end < 0) {
      i += width - 1;
      continue;
    }
    result.push({
      kind: "`",
      from: offset + i,
      to: offset + end + width,
      inner: { from: offset + i + width, to: offset + end },
    });
    code.push({ from: i, to: end + width });
    i = end + width - 1;
  }
  const isCode = (index: number) => code.some((range) => index >= range.from && index < range.to);
  for (const marker of ["*", "_"] as const) {
    const stack: { at: number; width: number }[] = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== marker || escaped(line, i) || isCode(i)) continue;
      let width = 1;
      while (line[i + width] === marker) width++;
      const before = line[i - 1] ?? " ";
      const after = line[i + width] ?? " ";
      const intraword =
        marker === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after);
      const opener = stack.at(-1);
      if (!intraword && opener && opener.width === width && !/\s/.test(before)) {
        stack.pop();
        const delimiterWidth = marker === "*" ? Math.min(width, 2) : width;
        result.push({
          kind: marker,
          from: offset + opener.at,
          to: offset + i + width,
          inner: {
            from: offset + opener.at + delimiterWidth,
            to: offset + i + width - delimiterWidth,
          },
        });
      } else if (!intraword && !/\s/.test(after)) stack.push({ at: i, width });
      i += width - 1;
    }
  }
  // Bracket nesting is tracked so destinations containing parentheses remain intact.
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "[" || escaped(line, i) || isCode(i)) continue;
    if (line[i + 1] === "[") {
      const end = line.indexOf("]]", i + 2);
      if (end >= 0) {
        result.push({
          kind: "l",
          from: offset + i,
          to: offset + end + 2,
          inner: { from: offset + i + 2, to: offset + end },
        });
        i = end + 1;
      }
      continue;
    }
    let depth = 1;
    let end = i + 1;
    for (; end < line.length && depth; end++) {
      if (escaped(line, end)) continue;
      if (line[end] === "[") depth++;
      if (line[end] === "]") depth--;
    }
    if (depth || line[end] !== "(") continue;
    const labelEnd = end - 1;
    depth = 1;
    let destination = end + 1;
    for (; destination < line.length && depth; destination++) {
      if (escaped(line, destination)) continue;
      if (line[destination] === "(") depth++;
      if (line[destination] === ")") depth--;
    }
    if (!depth) {
      result.push({
        kind: "l",
        from: offset + i,
        to: offset + destination,
        inner: { from: offset + i + 1, to: offset + labelEnd },
        alternateInner: { from: offset + end + 1, to: offset + destination - 1 },
      });
      i = destination - 1;
    }
  }
  return result;
}

/** Markdown structure is indexed once per document revision, never once per key. */
export function indexMarkdown(text: string): MarkdownIndex {
  const headings: Structure[] = [];
  const lists: Structure[] = [];
  const objects: MarkdownObject[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let fence: { marker: string; width: number; from: number; innerFrom: number } | undefined;
  let frontmatter = lines[0]?.trim() === "---";
  let previous: { from: number; text: string; eligible: boolean } | undefined;
  let inlineStart = 0;
  let inlineText = "";
  const flushInline = () => {
    if (inlineText) objects.push(...inlineObjects(inlineText, inlineStart));
    inlineText = "";
  };
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber];
    const lineEnd = offset + line.length;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (frontmatter) {
      flushInline();
      if (lineNumber > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
      previous = undefined;
    } else if (fence) {
      flushInline();
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.width &&
        /^\s*$/.test(fenceMatch[2])
      ) {
        objects.push({
          kind: "C",
          from: fence.from,
          to: lineEnd,
          inner: {
            from: Math.min(fence.innerFrom, offset),
            to: Math.max(fence.innerFrom, offset - 1),
          },
        });
        fence = undefined;
      }
      previous = undefined;
    } else if (fenceMatch && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
      flushInline();
      fence = {
        marker: fenceMatch[1][0],
        width: fenceMatch[1].length,
        from: offset,
        innerFrom: lineEnd + 1,
      };
      previous = undefined;
    } else {
      const list = /^(\s*)(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/.exec(line);
      const indented = /^( {4}|\t)/.test(line);
      const heading = /^ {0,3}#{1,6}(?:\s+|$)/.exec(line);
      if (heading) headings.push({ position: offset + heading[0].length, indent: 0 });
      if (/^ {0,3}(?:=+|-+)\s*$/.test(line) && previous?.eligible && previous.text.trim()) {
        headings.push({ position: previous.from + previous.text.search(/\S/), indent: 0 });
      }
      if (list)
        lists.push({
          position: offset + list[0].length,
          indent: list[1].replaceAll("\t", "    ").length,
        });
      if ((!indented || list) && line.trim()) {
        if (!inlineText) inlineStart = offset;
        else inlineText += "\n";
        inlineText += line;
      } else flushInline();
      previous = { from: offset, text: line, eligible: !indented && !list && !heading };
    }
    offset = lineEnd + 1;
  }
  flushInline();
  if (fence)
    objects.push({
      kind: "C",
      from: fence.from,
      to: text.length,
      inner: { from: Math.min(fence.innerFrom, text.length), to: text.length },
    });
  return { headings, lists, objects };
}

export function structureMotion(
  index: MarkdownIndex,
  text: string,
  offset: number,
  kind: "heading" | "list",
  forward: boolean,
  count = 1,
): number | undefined {
  let items = kind === "heading" ? index.headings : index.lists;
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const nextNewline = text.indexOf("\n", offset);
  const lineEnd = nextNewline < 0 ? text.length : nextNewline;
  if (kind === "list") {
    const current = items.find((item) => item.position >= lineStart && item.position <= lineEnd);
    const indent =
      current?.indent ??
      /^(\s*)/.exec(text.slice(lineStart, offset))![1].replaceAll("\t", "    ").length;
    items = items.filter((item) => item.indent === indent);
  }
  const candidates = items.filter((item) =>
    forward ? item.position > lineEnd : item.position < lineStart,
  );
  if (!forward) candidates.reverse();
  return candidates[Math.min(Math.max(count, 1), candidates.length) - 1]?.position;
}

export function markdownObject(
  index: MarkdownIndex,
  offset: number,
  kind: MarkdownObject["kind"],
  inner: boolean,
  count = 1,
): TextRange | undefined {
  const candidates = index.objects
    .filter((object) => object.kind === kind && offset >= object.from && offset < object.to)
    .sort((a, b) => a.to - a.from - (b.to - b.from));
  const selected = candidates[count - 1];
  if (!selected) return;
  if (!inner) return { from: selected.from, to: selected.to };
  if (selected.alternateInner && offset >= selected.alternateInner.from - 1)
    return selected.alternateInner;
  return selected.inner;
}
