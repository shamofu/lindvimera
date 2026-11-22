export interface SourceRange {
  from: number;
  to: number;
}

export interface VisibleSegment {
  text: string;
  from: number;
  to: number;
}

const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  laquo: "\u00AB",
  raquo: "\u00BB",
  bull: "\u2022",
  middot: "\u00B7",
  times: "\u00D7",
  divide: "\u00F7",
  plusmn: "\u00B1",
  deg: "\u00B0",
  rarr: "\u2192",
  larr: "\u2190",
  uarr: "\u2191",
  darr: "\u2193",
};

interface ParsedHtmlTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  end: number;
}

function parseHtmlTagAt(text: string, start: number): ParsedHtmlTag | null {
  if (text[start] !== "<") return null;
  let i = start + 1;
  let closing = false;
  if (text[i] === "/") {
    closing = true;
    i++;
  }
  const nameStart = i;
  if (!/[A-Za-z]/.test(text[i] ?? "")) return null;
  while (i < text.length && /[A-Za-z0-9:-]/.test(text[i])) i++;
  const name = text.slice(nameStart, i).toLowerCase();
  if (closing) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== ">") return null;
    return { name, closing: true, selfClosing: false, end: i + 1 };
  }
  if (i < text.length && !/[\s/>]/.test(text[i])) return null;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === ">") {
      let back = i - 1;
      while (back > nameStart && /\s/.test(text[back])) back--;
      const selfClosing = text[back] === "/" || VOID_HTML_TAGS.has(name);
      return { name, closing: false, selfClosing, end: i + 1 };
    }
    i++;
  }
  return null;
}

function decodeHtmlEntity(entity: string): string | null {
  const body = entity.slice(1, -1);
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const code = Number.parseInt(body.slice(2), 16);
    if (
      !Number.isFinite(code) ||
      code <= 0 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return null;
    return String.fromCodePoint(code);
  }
  if (body.startsWith("#")) {
    const code = Number.parseInt(body.slice(1), 10);
    if (
      !Number.isFinite(code) ||
      code <= 0 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return null;
    return String.fromCodePoint(code);
  }
  return NAMED_HTML_ENTITIES[body] ?? null;
}

function emitPlainSegments(
  source: string,
  from: number,
  to: number,
  baseOffset: number,
  out: VisibleSegment[],
): void {
  const slice = source.slice(from, to);
  const entityRe = /&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+);/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = entityRe.exec(slice)) !== null) {
    const decoded = decodeHtmlEntity(match[0]);
    if (!decoded) continue;
    if (match.index > cursor) {
      out.push({
        text: slice.slice(cursor, match.index),
        from: baseOffset + from + cursor,
        to: baseOffset + from + match.index,
      });
    }
    out.push({
      text: decoded,
      from: baseOffset + from + match.index,
      to: baseOffset + from + match.index + match[0].length,
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < slice.length) {
    out.push({
      text: slice.slice(cursor),
      from: baseOffset + from + cursor,
      to: baseOffset + to,
    });
  }
}

/** Parse inline HTML widget source into visible text segments mapped to source UTF-16 ranges. */
export function scanHtmlVisibleSegments(html: string, baseOffset = 0): VisibleSegment[] | null {
  if (!html.startsWith("<!--") && !parseHtmlTagAt(html, 0)) return null;
  const segments: VisibleSegment[] = [];
  let textStart = 0;
  let i = 0;
  const flush = (end: number) => {
    if (end > textStart) emitPlainSegments(html, textStart, end, baseOffset, segments);
  };
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      flush(i);
      const close = html.indexOf("-->", i + 4);
      i = close >= 0 ? close + 3 : html.length;
      textStart = i;
      continue;
    }
    const tag = parseHtmlTagAt(html, i);
    if (tag) {
      flush(i);
      i = tag.end;
      if (!tag.closing && !tag.selfClosing && (tag.name === "script" || tag.name === "style")) {
        const closeRe = new RegExp(`</${tag.name}\\s*>`, "i");
        const rest = html.slice(i);
        const match = closeRe.exec(rest);
        i = match ? i + match.index + match[0].length : html.length;
      }
      textStart = i;
      continue;
    }
    i++;
  }
  flush(html.length);
  return segments;
}

/** Parse single-line `$...$` / `$$...$$` inline math into inner visible source range. */
export function scanInlineMathVisibleSegments(
  source: string,
  baseOffset = 0,
): VisibleSegment[] | null {
  if (source.startsWith("$$") && source.endsWith("$$") && source.length >= 4) {
    return [
      {
        text: source.slice(2, -2),
        from: baseOffset + 2,
        to: baseOffset + source.length - 2,
      },
    ];
  }
  if (
    source.startsWith("$") &&
    !source.startsWith("$$") &&
    source.endsWith("$") &&
    source.length >= 2 &&
    !source.slice(1, -1).includes("$")
  ) {
    return [
      {
        text: source.slice(1, -1),
        from: baseOffset + 1,
        to: baseOffset + source.length - 1,
      },
    ];
  }
  return null;
}

function isEscaped(text: string, offset: number): boolean {
  let backslashes = 0;
  for (let i = offset - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

export function mergeRanges(ranges: readonly SourceRange[]): SourceRange[] {
  if (ranges.length <= 1) return ranges.filter((r) => r.to > r.from);
  const sorted = ranges.filter((r) => r.to > r.from).sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: SourceRange[] = [];
  for (const r of sorted) {
    const prev = merged.at(-1);
    if (prev && r.from <= prev.to) prev.to = Math.max(prev.to, r.to);
    else merged.push({ from: r.from, to: r.to });
  }
  return merged;
}

function containsRange(ranges: readonly SourceRange[], index: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const r = ranges[mid];
    if (index < r.from) high = mid - 1;
    else if (index >= r.to) low = mid + 1;
    else return true;
  }
  return false;
}

function overlapsRange(ranges: readonly SourceRange[], from: number, to: number): boolean {
  for (const r of ranges) {
    if (r.to <= from) continue;
    if (r.from >= to) break;
    return true;
  }
  return false;
}

/** Static inline syntax fallback for expanded origin lines and off-viewport destinations. */
export function scanCanonicalInlineHiddenRanges(
  lineText: string,
  bodyStart: number,
): SourceRange[] {
  const start = Math.max(0, Math.min(bodyStart, lineText.length));
  const hidden: SourceRange[] = [];
  const literalZones: SourceRange[] = [];

  // 1. Inline code spans (`...`). Interior is literal.
  for (let i = start; i < lineText.length; i++) {
    if (lineText[i] !== "`" || isEscaped(lineText, i)) continue;
    let width = 1;
    while (lineText[i + width] === "`") width++;
    const delimiter = "`".repeat(width);
    let close = i + width;
    while ((close = lineText.indexOf(delimiter, close)) >= 0) {
      if (lineText[close - 1] !== "`" && lineText[close + width] !== "`") break;
      close += width;
    }
    if (close >= 0) {
      hidden.push({ from: i, to: i + width }, { from: close, to: close + width });
      literalZones.push({ from: i, to: close + width });
      i = close + width - 1;
    } else {
      i += width - 1;
    }
  }

  // 2. Paired inline HTML tags (<ins>...</ins>, comments, void tags).
  // Markdown inside paired HTML stays literal in Obsidian Live Preview.
  const tagStack: { name: string; from: number; to: number }[] = [];
  const htmlSpans: SourceRange[] = [];
  for (let i = start; i < lineText.length; i++) {
    if (lineText[i] !== "<" || isEscaped(lineText, i) || containsRange(literalZones, i)) continue;
    if (lineText.startsWith("<!--", i)) {
      const close = lineText.indexOf("-->", i + 4);
      const end = close >= 0 ? close + 3 : lineText.length;
      if (!overlapsRange(literalZones, i, end)) {
        hidden.push({ from: i, to: end });
        htmlSpans.push({ from: i, to: end });
        i = end - 1;
      }
      continue;
    }
    const tag = parseHtmlTagAt(lineText, i);
    if (!tag || overlapsRange(literalZones, i, tag.end)) continue;
    if (tag.closing) {
      let matchIdx = -1;
      for (let s = tagStack.length - 1; s >= 0; s--) {
        if (tagStack[s].name === tag.name) {
          matchIdx = s;
          break;
        }
      }
      if (matchIdx >= 0) {
        const opener = tagStack[matchIdx];
        tagStack.length = matchIdx;
        hidden.push({ from: opener.from, to: opener.to }, { from: i, to: tag.end });
        htmlSpans.push({ from: opener.from, to: tag.end });
      }
    } else if (tag.selfClosing) {
      hidden.push({ from: i, to: tag.end });
      htmlSpans.push({ from: i, to: tag.end });
    } else {
      tagStack.push({ name: tag.name, from: i, to: tag.end });
    }
    i = tag.end - 1;
  }

  const protectedZones = mergeRanges([...literalZones, ...htmlSpans]);

  // 3. Inline math ($...$ / $$...$$).
  for (let i = start; i < lineText.length; i++) {
    if (lineText[i] !== "$" || isEscaped(lineText, i) || containsRange(protectedZones, i)) continue;
    const width = lineText[i + 1] === "$" ? 2 : 1;
    const openEnd = i + width;
    if (width === 1 && /\s/.test(lineText[openEnd] ?? "")) continue;
    let close = -1;
    for (let j = openEnd; j < lineText.length; j++) {
      if (lineText[j] !== "$" || isEscaped(lineText, j) || containsRange(protectedZones, j))
        continue;
      if (width === 2) {
        if (lineText[j + 1] === "$") {
          close = j;
          break;
        }
      } else if (lineText[j + 1] !== "$" && !/\s/.test(lineText[j - 1] ?? "")) {
        close = j;
        break;
      }
    }
    if (close >= 0) {
      hidden.push({ from: i, to: openEnd }, { from: close, to: close + width });
      protectedZones.push({ from: i, to: close + width });
      protectedZones.sort((a, b) => a.from - b.from || a.to - b.to);
      i = close + width - 1;
    } else {
      i += width - 1;
    }
  }

  const allProtected = mergeRanges(protectedZones);
  const linkZones: SourceRange[] = [...allProtected];

  // 4. Wiki links ([[target|alias]] / [[target]]) and Markdown links ([text](url)).
  for (let i = start; i < lineText.length; i++) {
    if (lineText[i] !== "[" || isEscaped(lineText, i) || containsRange(allProtected, i)) continue;
    if (lineText[i + 1] === "[") {
      const end = lineText.indexOf("]]", i + 2);
      if (end >= 0 && !overlapsRange(allProtected, i, end + 2)) {
        const pipe = lineText.indexOf("|", i + 2);
        const openEnd = pipe >= 0 && pipe < end ? pipe + 1 : i + 2;
        hidden.push({ from: i, to: openEnd }, { from: end, to: end + 2 });
        linkZones.push({ from: i, to: openEnd }, { from: end, to: end + 2 });
        i = end + 1;
        continue;
      }
    }
    let depth = 1;
    let closeBracket = i + 1;
    for (; closeBracket < lineText.length && depth > 0; closeBracket++) {
      if (isEscaped(lineText, closeBracket) || containsRange(allProtected, closeBracket)) continue;
      if (lineText[closeBracket] === "[") depth++;
      else if (lineText[closeBracket] === "]") depth--;
    }
    if (depth === 0 && lineText[closeBracket] === "(") {
      let pDepth = 1;
      let closeParen = closeBracket + 1;
      for (; closeParen < lineText.length && pDepth > 0; closeParen++) {
        if (isEscaped(lineText, closeParen) || containsRange(allProtected, closeParen)) continue;
        if (lineText[closeParen] === "(") pDepth++;
        else if (lineText[closeParen] === ")") pDepth--;
      }
      if (pDepth === 0 && !overlapsRange(allProtected, i, closeParen)) {
        hidden.push({ from: i, to: i + 1 }, { from: closeBracket - 1, to: closeParen });
        linkZones.push({ from: i, to: i + 1 }, { from: closeBracket - 1, to: closeParen });
        i = closeParen - 1;
      }
    }
  }

  const nonDelimZones = mergeRanges(linkZones);

  // 5. Emphasis, highlight, strikethrough delimiters (*, _, ==, ~~).
  for (const marker of ["*", "_", "=", "~"] as const) {
    const stack: { at: number; width: number }[] = [];
    for (let i = start; i < lineText.length; i++) {
      if (lineText[i] !== marker || isEscaped(lineText, i) || containsRange(nonDelimZones, i))
        continue;
      let width = 1;
      while (lineText[i + width] === marker) width++;
      if ((marker === "=" || marker === "~") && width !== 2) {
        i += width - 1;
        continue;
      }
      const before = lineText[i - 1] ?? " ";
      const after = lineText[i + width] ?? " ";
      const intraword =
        marker === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after);
      const opener = stack.at(-1);
      if (!intraword && opener && opener.width === width && !/\s/.test(before)) {
        stack.pop();
        const delimiterWidth = marker === "*" || marker === "_" ? Math.min(width, 3) : width;
        hidden.push(
          { from: opener.at, to: opener.at + delimiterWidth },
          { from: i + width - delimiterWidth, to: i + width },
        );
      } else if (!intraword && !/\s/.test(after)) {
        stack.push({ at: i, width });
      }
      i += width - 1;
    }
  }

  return mergeRanges(hidden);
}
