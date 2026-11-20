import { EditorSelection, EditorState, Transaction, type Extension } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  type Decoration,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { markdownContentStart, type MarkdownEditingIndex } from "./editing";
import {
  moveBigWord,
  type WordBoundaryCache,
  type WordDocument,
  type WordPosition,
  type WordProvider,
} from "../word";

export interface SourceRange {
  from: number;
  to: number;
}

export interface VisibleSegment {
  text: string;
  from: number;
  to: number;
}

export interface VerticalGoalState {
  goal?: number;
  goalHead?: WordPosition;
}

export interface DisplayVerticalGoalState {
  goalColumn?: number;
  goalCenterBias?: number;
  goalHead?: WordPosition;
}

export interface LineProjection {
  readonly lineFrom: number;
  readonly lineText: string;
  readonly bodyStart: number;
  readonly visibleText: string;
  readonly visToSrc: readonly number[];
  readonly hiddenRanges: readonly SourceRange[];
  readonly collapsedSpans: readonly SourceRange[];
  readonly emptySpans: readonly SourceRange[];
  readonly hasHidden: boolean;
  srcToVis(ch: number): number;
  visToSrcCh(visCh: number): number;
  graphemeColumnOf(ch: number): number;
  srcChAtGraphemeColumn(column: number): number;
}

export interface LivePreviewDocument extends WordDocument {
  project(line: number): LineProjection;
  toVisible(position: WordPosition): WordPosition;
  toSource(position: WordPosition): WordPosition;
}

const graphemeSegmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

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

function mergeRanges(ranges: readonly SourceRange[]): SourceRange[] {
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

interface ReplaceDecoInfo {
  from: number;
  to: number;
  widget: unknown;
}

function collectLineReplaceDecorations(
  view: EditorView,
  lineFrom: number,
  lineTo: number,
): ReplaceDecoInfo[] {
  const providers = view.state.facet(EditorView.decorations);
  const found: ReplaceDecoInfo[] = [];
  for (const provider of providers) {
    let set: DecorationSet;
    try {
      set = typeof provider === "function" ? provider(view) : provider;
    } catch {
      continue;
    }
    if (!set || typeof set.between !== "function") continue;
    set.between(lineFrom, lineTo, (from: number, to: number, value: Decoration) => {
      const spec = value.spec as { block?: boolean; widget?: unknown } | undefined;
      const block = !!(value as unknown as { block?: boolean }).block || !!spec?.block;
      if (value.point && from < to && !block && from >= lineFrom && to <= lineTo) {
        const widget = (value as unknown as { widget?: unknown }).widget ?? spec?.widget ?? null;
        found.push({ from, to, widget });
      }
    });
  }
  if (found.length <= 1) return found;
  found.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: ReplaceDecoInfo[] = [];
  for (const item of found) {
    const prev = merged.at(-1);
    if (prev && item.from < prev.to) {
      if (item.to > prev.to) {
        prev.to = item.to;
        if (!prev.widget) prev.widget = item.widget;
      }
    } else {
      merged.push({ ...item });
    }
  }
  return merged;
}

function buildProjection(
  lineFrom: number,
  lineText: string,
  bodyStart: number,
  segments: readonly VisibleSegment[],
  hiddenRanges: readonly SourceRange[],
  collapsedSpans: readonly SourceRange[],
  emptySpans: readonly SourceRange[] = [],
): LineProjection {
  const parts: string[] = [];
  const visToSrc: number[] = [];
  const segMaps: {
    visStart: number;
    visEnd: number;
    srcFrom: number;
    srcTo: number;
    oneToOne: boolean;
  }[] = [];

  let visLen = 0;
  for (const seg of segments) {
    if (!seg.text) continue;
    const visStart = visLen;
    const oneToOne = seg.text.length === seg.to - seg.from;
    parts.push(seg.text);
    for (let k = 0; k < seg.text.length; k++) {
      visToSrc.push(oneToOne ? seg.from + k : seg.from);
    }
    visLen += seg.text.length;
    segMaps.push({ visStart, visEnd: visLen, srcFrom: seg.from, srcTo: seg.to, oneToOne });
  }
  const visibleText = parts.join("");
  visToSrc.push(lineText.length);

  const graphemes = [...graphemeSegmenter.segment(visibleText)].map((part) => part.index);

  const srcToVis = (ch: number): number => {
    const clamped = Math.max(bodyStart, Math.min(ch, lineText.length));
    for (const seg of segMaps) {
      if (clamped < seg.srcFrom) return seg.visStart;
      if (clamped < seg.srcTo) {
        return seg.oneToOne ? seg.visStart + (clamped - seg.srcFrom) : seg.visStart;
      }
    }
    return visibleText.length;
  };

  const visToSrcCh = (visCh: number): number => {
    if (visibleText.length === 0) return Math.min(bodyStart, lineText.length);
    if (visCh <= 0) return visToSrc[0] ?? bodyStart;
    if (visCh >= visibleText.length) return visToSrc[visibleText.length] ?? lineText.length;
    return visToSrc[visCh];
  };

  const graphemeColumnOf = (ch: number): number => {
    if (ch <= bodyStart || graphemes.length === 0) return 0;
    const vis = srcToVis(ch);
    let col = 0;
    for (let i = 0; i < graphemes.length; i++) {
      if (graphemes[i] <= vis) col = i;
      else break;
    }
    return vis >= visibleText.length ? graphemes.length : col;
  };

  const srcChAtGraphemeColumn = (column: number): number => {
    if (graphemes.length === 0) return Math.min(Math.max(0, lineText.length - 1), bodyStart);
    const targetCol = !Number.isFinite(column)
      ? graphemes.length - 1
      : Math.max(0, Math.min(column, graphemes.length - 1));
    const src = visToSrcCh(graphemes[targetCol]);
    return Math.min(Math.max(0, lineText.length - 1), src);
  };

  return {
    lineFrom,
    lineText,
    bodyStart,
    visibleText,
    visToSrc,
    hiddenRanges,
    collapsedSpans,
    emptySpans,
    hasHidden: hiddenRanges.length > 0,
    srcToVis,
    visToSrcCh,
    graphemeColumnOf,
    srcChAtGraphemeColumn,
  };
}

function buildSegmentsFromHidden(
  lineText: string,
  bodyStart: number,
  hiddenRanges: readonly SourceRange[],
): VisibleSegment[] {
  const segments: VisibleSegment[] = [];
  let cursor = bodyStart;
  for (const r of hiddenRanges) {
    if (r.to <= cursor || r.from >= lineText.length) continue;
    const from = Math.max(cursor, r.from);
    const to = Math.min(lineText.length, r.to);
    if (from > cursor) {
      segments.push({ text: lineText.slice(cursor, from), from: cursor, to: from });
    }
    cursor = Math.max(cursor, to);
  }
  if (cursor < lineText.length) {
    segments.push({ text: lineText.slice(cursor), from: cursor, to: lineText.length });
  }
  return segments;
}

/** Whether `view` is a body editor inside an Obsidian Live Preview container (never a table cell). */
export function isLivePreviewView(view: EditorView): boolean {
  return (
    !!view.dom.closest(".markdown-source-view.is-live-preview") &&
    !view.dom.closest(".cm-table-widget")
  );
}

/** Build a line projection from CM6's active collapsed inline replace decorations. */
export function projectCollapsedLine(
  view: EditorView,
  lineNumber: number,
  bodyStart = 0,
): LineProjection {
  const line = view.state.doc.line(lineNumber + 1);
  const clampedStart = Math.max(0, Math.min(bodyStart, line.text.length));
  const decos = collectLineReplaceDecorations(view, line.from + clampedStart, line.to);
  if (decos.length === 0) {
    const segs =
      clampedStart < line.text.length
        ? [{ text: line.text.slice(clampedStart), from: clampedStart, to: line.text.length }]
        : [];
    return buildProjection(line.from, line.text, clampedStart, segs, [], []);
  }

  const segments: VisibleSegment[] = [];
  const hidden: SourceRange[] = [];
  const collapsedSpans: SourceRange[] = [];
  const emptySpans: SourceRange[] = [];
  let cursor = clampedStart;

  for (const deco of decos) {
    const dFrom = Math.max(clampedStart, deco.from - line.from);
    const dTo = Math.min(line.text.length, deco.to - line.from);
    if (dTo <= dFrom) continue;
    collapsedSpans.push({ from: dFrom, to: dTo });
    if (dFrom > cursor) {
      segments.push({ text: line.text.slice(cursor, dFrom), from: cursor, to: dFrom });
    }
    const slice = line.text.slice(dFrom, dTo);
    const parsedHtml = scanHtmlVisibleSegments(slice, dFrom);
    if (!deco.widget) {
      hidden.push({ from: dFrom, to: dTo });
      if (parsedHtml?.every((s) => !s.text)) emptySpans.push({ from: dFrom, to: dTo });
    } else {
      const parsed = parsedHtml ?? scanInlineMathVisibleSegments(slice, dFrom);
      if (parsed) {
        if (parsedHtml && parsedHtml.every((s) => !s.text)) {
          emptySpans.push({ from: dFrom, to: dTo });
        }
        let hCursor = dFrom;
        for (const seg of parsed) {
          if (seg.from > hCursor) hidden.push({ from: hCursor, to: seg.from });
          if (seg.text) segments.push(seg);
          hCursor = Math.max(hCursor, seg.to);
        }
        if (hCursor < dTo) hidden.push({ from: hCursor, to: dTo });
      } else {
        // Opaque non-HTML/math inline widget (e.g. task checkbox) acts as a 1-char anchor at dFrom.
        segments.push({ text: "\uFFFC", from: dFrom, to: dTo });
      }
    }
    cursor = dTo;
  }
  if (cursor < line.text.length) {
    segments.push({ text: line.text.slice(cursor), from: cursor, to: line.text.length });
  }
  return buildProjection(
    line.from,
    line.text,
    clampedStart,
    segments,
    mergeRanges(hidden),
    collapsedSpans,
    emptySpans,
  );
}

/** Build a line projection using static inline Markdown/HTML parsing (expanded or off-viewport lines). */
export function projectCanonicalLine(
  lineText: string,
  bodyStart = 0,
  blocked = false,
): LineProjection {
  const clampedStart = Math.max(0, Math.min(bodyStart, lineText.length));
  const hidden = blocked ? [] : scanCanonicalInlineHiddenRanges(lineText, clampedStart);
  const segments = buildSegmentsFromHidden(lineText, clampedStart, hidden);
  return buildProjection(0, lineText, clampedStart, segments, hidden, []);
}

function projectOriginLine(
  view: EditorView,
  lineNumber: number,
  bodyStart: number,
  blocked: boolean,
): LineProjection {
  const collapsed = projectCollapsedLine(view, lineNumber, bodyStart);
  if (blocked) return collapsed;
  const canonicalHidden = scanCanonicalInlineHiddenRanges(collapsed.lineText, bodyStart);
  if (canonicalHidden.length === 0) return collapsed;
  const merged = mergeRanges([...collapsed.hiddenRanges, ...canonicalHidden]);
  const segments = buildSegmentsFromHidden(collapsed.lineText, bodyStart, merged);
  return buildProjection(
    collapsed.lineFrom,
    collapsed.lineText,
    bodyStart,
    segments,
    merged,
    collapsed.collapsedSpans,
  );
}

/** Wrap a WordDocument so horizontal motions skip only currently-collapsed Live Preview ranges. */
export function createLivePreviewDocument(
  view: EditorView,
  source: WordDocument,
): LivePreviewDocument {
  const cache = new Map<number, LineProjection>();
  const project = (line: number): LineProjection => {
    let hit = cache.get(line);
    if (!hit) {
      hit = projectCollapsedLine(view, line, 0);
      cache.set(line, hit);
    }
    return hit;
  };
  return {
    firstLine: () => source.firstLine(),
    lastLine: () => source.lastLine(),
    getLine: (line) => project(line).visibleText,
    project,
    toVisible: (pos) => ({ line: pos.line, ch: project(pos.line).srcToVis(pos.ch) }),
    toSource: (pos) => ({ line: pos.line, ch: project(pos.line).visToSrcCh(pos.ch) }),
  };
}

function lastVisibleGraphemeStart(visibleText: string): number {
  if (!visibleText) return 0;
  let last = 0;
  for (const part of graphemeSegmenter.segment(visibleText)) last = part.index;
  return last;
}

/** Horizontal `h`/`l` motion on collapsed Live Preview lines, allowing entry into trailing/leading empty tags. */
export function livePreviewCharacter(
  view: EditorView,
  source: WordDocument,
  head: WordPosition,
  forward: boolean,
  repeat: number,
  provider: WordProvider,
): WordPosition {
  const doc = createLivePreviewDocument(view, source);
  const proj = doc.project(head.line);
  if (!proj.hasHidden && proj.collapsedSpans.length === 0) {
    let target = head;
    for (let i = 0; i < repeat; i++) target = provider.character(source, target, forward ? 1 : -1);
    return target;
  }
  const visHead = doc.toVisible(head);
  const lastVis = lastVisibleGraphemeStart(proj.visibleText);
  if (
    proj.visibleText.length === 0 &&
    proj.emptySpans.some((span) => head.ch >= span.from && head.ch < span.to)
  ) {
    return { line: head.line, ch: Math.min(head.ch, Math.max(0, proj.lineText.length - 1)) };
  }
  if (forward && proj.visibleText.length > 0 && visHead.ch >= lastVis) {
    const trailingEmpty = proj.emptySpans.find((span) => span.from > head.ch);
    if (trailingEmpty) return { line: head.line, ch: trailingEmpty.from };
  }
  if (!forward && visHead.ch === 0) {
    const leadingEmpty = [...proj.emptySpans]
      .reverse()
      .find((span) => span.to <= head.ch && span.from < head.ch);
    if (leadingEmpty) return { line: head.line, ch: leadingEmpty.from };
  }
  let target = visHead;
  for (let i = 0; i < repeat; i++) {
    const next = provider.character(doc, target, forward ? 1 : -1);
    if (next.ch >= proj.visibleText.length) {
      // Stepping past the last visible character on a line: allow entering a trailing empty tag if present.
      const trailingEmpty = proj.emptySpans.find((span) => span.from >= proj.visToSrcCh(target.ch));
      if (trailingEmpty && target.ch >= lastVis) {
        return { line: head.line, ch: trailingEmpty.from };
      }
      target = { line: head.line, ch: proj.visibleText.length ? lastVis : 0 };
      break;
    }
    target = next;
  }
  return doc.toSource(target);
}

/** Word / WORD motion (`w`/`b`/`e`/`ge`/`W`/`B`/`E`/`gE`) across collapsed Live Preview lines. */
export function livePreviewWord(
  view: EditorView,
  source: WordDocument,
  head: WordPosition,
  args: { repeat: number; forward?: boolean; wordEnd?: boolean; bigWord?: boolean },
  provider: WordProvider,
  cache?: WordBoundaryCache,
): WordPosition {
  const doc = createLivePreviewDocument(view, source);
  const visHead = doc.toVisible(head);
  const target = args.bigWord
    ? moveBigWord(
        doc,
        visHead,
        {
          repeat: args.repeat,
          forward: args.forward,
          wordEnd: args.wordEnd,
        },
        cache,
      )
    : provider.move(doc, visHead, {
        repeat: args.repeat,
        forward: args.forward,
        wordEnd: args.wordEnd,
      });
  const destProj = doc.project(target.line);
  if (target.ch >= destProj.visibleText.length) {
    const clampedVis = destProj.visibleText.length
      ? lastVisibleGraphemeStart(destProj.visibleText)
      : 0;
    return destProj.visibleText.length
      ? { line: target.line, ch: destProj.visToSrcCh(clampedVis) }
      : { line: target.line, ch: 0 };
  }
  return doc.toSource(target);
}

/** Adjust `^` content-start position past any collapsed leading inline decoration in Live Preview. */
export function livePreviewContentStart(
  view: EditorView,
  lineNumber: number,
  bodyStart: number,
): number {
  const proj = projectCollapsedLine(view, lineNumber, 0);
  if (!proj.hasHidden) return bodyStart;
  const vis = proj.srcToVis(bodyStart);
  if (vis >= proj.visibleText.length) return bodyStart;
  return proj.visToSrcCh(vis);
}

function isLineInViewport(view: EditorView, lineFrom: number, lineTo: number): boolean {
  for (const range of view.visibleRanges) {
    if (lineTo >= range.from && lineFrom <= range.to) return true;
  }
  return false;
}

function hasAnyReplaceDecorations(view: EditorView): boolean {
  const providers = view.state.facet(EditorView.decorations);
  for (const provider of providers) {
    let set: DecorationSet;
    try {
      set = typeof provider === "function" ? provider(view) : provider;
    } catch {
      continue;
    }
    if (!set || typeof set.iter !== "function") continue;
    const cur = set.iter(0);
    while (cur.value) {
      const spec = cur.value.spec as { block?: boolean } | undefined;
      const block = !!(cur.value as unknown as { block?: boolean }).block || !!spec?.block;
      if (cur.value.point && cur.from < cur.to && !block) return true;
      cur.next();
    }
  }
  return false;
}

export interface VerticalMotionParams {
  view?: EditorView;
  doc: WordDocument;
  index: MarkdownEditingIndex;
  indexFromPos: (pos: WordPosition) => number;
  head: WordPosition;
  forward: boolean;
  repeat: number;
  state: VerticalGoalState;
  findPosV?: (
    head: WordPosition,
    amount: number,
    unit: "line" | "page",
    horizontal?: number,
  ) => WordPosition & { focusBefore?: () => void; hitSide?: boolean };
  charCoords?: (pos: WordPosition, mode: "div" | "local") => { left: number };
  lastHPos?: number;
  lastHSPos?: number;
}

export interface VerticalMotionResult {
  position: WordPosition;
  lastHPos: number;
  lastHSPos: number | undefined;
}

/** Resolve `j`/`k` preserving body-relative visible grapheme columns across prefixes and inline decorations. */
export function resolveLiveVerticalMotion(params: VerticalMotionParams): VerticalMotionResult {
  const { view, doc, index, indexFromPos, head, forward, repeat, state, findPosV, charCoords } =
    params;
  if (state.goalHead && (state.goalHead.line !== head.line || state.goalHead.ch !== head.ch)) {
    state.goal = undefined;
  }

  const bodyOffsetForLine = (line: number): { bodyStart: number; blocked: boolean } => {
    const lineStart = indexFromPos({ line, ch: 0 });
    const content = markdownContentStart(index, lineStart);
    if (content === undefined) return { bodyStart: 0, blocked: true };
    return { bodyStart: Math.max(0, content - lineStart), blocked: false };
  };

  if (state.goal === undefined) {
    if (params.lastHPos === Infinity) {
      state.goal = Infinity;
    } else {
      const originMeta = bodyOffsetForLine(head.line);
      if (view) {
        const originProj = projectOriginLine(
          view,
          head.line,
          originMeta.bodyStart,
          originMeta.blocked,
        );
        state.goal = originProj.graphemeColumnOf(head.ch);
      } else {
        const originProj = projectCanonicalLine(
          doc.getLine(head.line),
          originMeta.bodyStart,
          originMeta.blocked,
        );
        state.goal = originProj.graphemeColumnOf(head.ch);
      }
    }
  }

  const amount = (forward ? 1 : -1) * repeat;
  const visible = findPosV?.(head, amount, "line", params.lastHSPos);
  if (visible?.focusBefore) {
    visible.focusBefore();
    return { position: head, lastHPos: head.ch, lastHSPos: params.lastHSPos };
  }
  if (visible?.hitSide && visible.line === head.line && visible.ch === head.ch) {
    return { position: head, lastHPos: head.ch, lastHSPos: params.lastHSPos };
  }

  const physical = Math.max(doc.firstLine(), Math.min(doc.lastLine(), head.line + amount));
  const line = visible
    ? forward
      ? Math.max(physical, visible.line)
      : Math.min(physical, visible.line)
    : physical;

  const destMeta = bodyOffsetForLine(line);
  const destText = doc.getLine(line);
  let destProj: LineProjection;
  if (view) {
    const cmLine = view.state.doc.line(line + 1);
    const inViewport = isLineInViewport(view, cmLine.from, cmLine.to);
    const liveDom = isLivePreviewView(view);
    if (inViewport && (liveDom || hasAnyReplaceDecorations(view))) {
      destProj =
        line === head.line
          ? projectOriginLine(view, line, destMeta.bodyStart, destMeta.blocked)
          : projectCollapsedLine(view, line, destMeta.bodyStart);
    } else {
      destProj = projectCanonicalLine(destText, destMeta.bodyStart, destMeta.blocked);
    }
  } else {
    destProj = projectCanonicalLine(destText, destMeta.bodyStart, destMeta.blocked);
  }

  const ch = destProj.srcChAtGraphemeColumn(state.goal);
  const position = { line, ch };
  state.goalHead = position;
  return {
    position,
    lastHPos: ch,
    lastHSPos: charCoords?.(position, "div").left,
  };
}

function findEmbedElementForDecoration(
  view: EditorView,
  decoFrom: number,
  decoTo: number,
): HTMLElement | null {
  const embeds = view.contentDOM.querySelectorAll<HTMLElement>(".cm-html-embed");
  if (!embeds.length) return null;
  const expectedText = (
    scanHtmlVisibleSegments(view.state.doc.sliceString(decoFrom, decoTo), decoFrom) ?? []
  )
    .map((s) => s.text)
    .join("");
  let fallback: HTMLElement | null = null;
  for (const el of embeds) {
    let pos: number;
    try {
      pos = view.posAtDOM(el);
    } catch {
      continue;
    }
    if (pos === decoFrom) {
      if ((el.textContent ?? "") === expectedText) return el;
      fallback ??= el;
    } else if (pos >= decoFrom && pos <= decoTo && !fallback) {
      fallback = el;
    }
  }
  return fallback;
}

/** Resolve a screen `(clientX, clientY)` point inside a `.cm-html-embed` widget to a source UTF-16 offset. */
export function resolveHtmlWidgetOffsetAtPoint(
  view: EditorView,
  embed: HTMLElement,
  decoFrom: number,
  decoTo: number,
  clientX: number,
  clientY: number,
  insertMode: boolean,
): number | null {
  const html = view.state.doc.sliceString(decoFrom, decoTo);
  const segments = scanHtmlVisibleSegments(html, decoFrom);
  if (!segments || segments.length === 0) return null;
  const visibleSourceOffsets: { from: number; to: number }[] = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    const oneToOne = seg.text.length === seg.to - seg.from;
    for (let k = 0; k < seg.text.length; k++) {
      visibleSourceOffsets.push(
        oneToOne ? { from: seg.from + k, to: seg.from + k + 1 } : { from: seg.from, to: seg.to },
      );
    }
  }
  if (visibleSourceOffsets.length === 0) return null;

  const ownerDoc = view.dom.ownerDocument;
  const walker = ownerDoc.createTreeWalker(embed, 4 /* NodeFilter.SHOW_TEXT */);
  const candidates: {
    visStart: number;
    visEnd: number;
    rect: DOMRect;
    dy: number;
    dx: number;
  }[] = [];

  let visCursor = 0;
  let minDy = Infinity;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (parent && /^(?:STYLE|SCRIPT)$/i.test(parent.tagName)) continue;
    const text = node.nodeValue ?? "";
    if (!text) continue;
    for (const part of graphemeSegmenter.segment(text)) {
      const gStart = part.index;
      const gEnd = gStart + part.segment.length;
      const range = ownerDoc.createRange();
      range.setStart(node, gStart);
      range.setEnd(node, gEnd);
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        if (rect.width === 0 && rect.height === 0) continue;
        const dy =
          clientY < rect.top
            ? rect.top - clientY
            : clientY > rect.bottom
              ? clientY - rect.bottom
              : 0;
        const dx =
          clientX < rect.left
            ? rect.left - clientX
            : clientX > rect.right
              ? clientX - rect.right
              : 0;
        if (dy < minDy) minDy = dy;
        candidates.push({
          visStart: visCursor + gStart,
          visEnd: visCursor + gEnd,
          rect,
          dy,
          dx,
        });
      }
    }
    visCursor += text.length;
  }
  if (candidates.length === 0) return null;

  // Allow slight vertical offset tolerance for <sub>/<sup> on the same visual line.
  const sameRowCandidates = candidates.filter((c) => c.dy <= minDy + 4);
  let best = sameRowCandidates[0];
  for (const c of sameRowCandidates) {
    if (c.dx < best.dx || (c.dx === best.dx && c.dy < best.dy)) best = c;
  }

  const clampedStart = Math.max(0, Math.min(best.visStart, visibleSourceOffsets.length - 1));
  const clampedEnd = Math.max(
    clampedStart,
    Math.min(best.visEnd - 1, visibleSourceOffsets.length - 1),
  );
  if (insertMode && clientX > (best.rect.left + best.rect.right) / 2) {
    return visibleSourceOffsets[clampedEnd].to;
  }
  return visibleSourceOffsets[clampedStart].from;
}

export interface DisplayVerticalMotionParams {
  view: EditorView;
  doc: WordDocument;
  head: WordPosition;
  forward: boolean;
  repeat: number;
  state: DisplayVerticalGoalState;
  findPosV: (
    head: WordPosition,
    amount: number,
    unit: "line" | "page",
    horizontal?: number,
  ) => WordPosition & { focusBefore?: () => void; hitSide?: boolean };
  charCoords: (pos: WordPosition, mode: "div" | "local") => { left: number };
  lastHSPos?: number;
}

export interface DisplayVerticalMotionResult {
  position: WordPosition;
  lastHPos: number;
  lastHSPos: number | undefined;
  focusBefore?: () => void;
  hitSide?: boolean;
}

/** Resolve `gj`/`gk` using screen X coordinates and landing inside collapsed `.cm-html-embed` widgets. */
export function resolveLiveDisplayVerticalMotion(
  params: DisplayVerticalMotionParams,
): DisplayVerticalMotionResult {
  const { view, head, forward, repeat, state, findPosV, charCoords } = params;
  if (state.goalHead && (state.goalHead.line !== head.line || state.goalHead.ch !== head.ch)) {
    state.goalColumn = undefined;
    state.goalCenterBias = undefined;
  }

  if (state.goalColumn === undefined) {
    const startOffset = view.state.doc.line(head.line + 1).from + head.ch;
    const charRect = view.coordsForChar(startOffset) ?? view.coordsAtPos(startOffset, 1);
    const contentLeft = view.contentDOM.getBoundingClientRect().left;
    state.goalColumn = charRect ? charRect.left - contentLeft : charCoords(head, "div").left;
    state.goalCenterBias =
      charRect && charRect.right > charRect.left
        ? Math.min(4, (charRect.right - charRect.left) * 0.4)
        : 2;
  }

  let cur = head;
  let focusBefore: (() => void) | undefined;
  let hitSide = false;
  for (let i = 0; i < Math.max(1, repeat); i++) {
    const res = findPosV(cur, forward ? 1 : -1, "line", state.goalColumn);
    if (res.focusBefore) {
      focusBefore = res.focusBefore;
      break;
    }
    if (res.hitSide) {
      hitSide = true;
      break;
    }
    cur = { line: res.line, ch: res.ch };
  }

  if (focusBefore) {
    focusBefore();
    return { position: head, lastHPos: head.ch, lastHSPos: state.goalColumn, focusBefore };
  }
  if (hitSide && cur.line === head.line && cur.ch === head.ch) {
    return { position: head, lastHPos: head.ch, lastHSPos: state.goalColumn, hitSide: true };
  }

  const destLine = view.state.doc.line(cur.line + 1);
  let destOffset = Math.max(destLine.from, Math.min(destLine.to, destLine.from + cur.ch));
  const decos = collectLineReplaceDecorations(view, destLine.from, destLine.to);

  if (decos.length > 0) {
    for (const deco of decos) {
      if (deco.widget) continue;
      if (destOffset >= deco.from && destOffset < deco.to) {
        if (deco.to < destLine.to) {
          destOffset = deco.to;
        } else {
          const proj = projectCollapsedLine(view, cur.line, 0);
          const vis = proj.srcToVis(deco.from - destLine.from);
          const prev = vis > 0 ? lastVisibleGraphemeStart(proj.visibleText.slice(0, vis)) : 0;
          destOffset = destLine.from + (proj.visibleText.length ? proj.visToSrcCh(prev) : 0);
          break;
        }
      }
    }

    const contentRect = view.contentDOM.getBoundingClientRect();
    const targetClientX = contentRect.left + state.goalColumn + (state.goalCenterBias ?? 2);
    const destCoords = view.coordsAtPos(destOffset, 1);

    for (const deco of decos) {
      if (!deco.widget) continue;
      const slice = view.state.doc.sliceString(deco.from, deco.to);
      const isHtml = scanHtmlVisibleSegments(slice, deco.from) !== null;
      if (isHtml) {
        const embed = findEmbedElementForDecoration(view, deco.from, deco.to);
        if (!embed) continue;
        const rect = embed.getBoundingClientRect();
        const sameVisualRow =
          !destCoords || (destCoords.bottom >= rect.top - 2 && destCoords.top <= rect.bottom + 2);
        const insideStrict = destOffset > deco.from && destOffset < deco.to;
        const xOverEmbed =
          sameVisualRow && targetClientX >= rect.left - 1 && targetClientX < rect.right;
        if (insideStrict || xOverEmbed) {
          const resolved = resolveHtmlWidgetOffsetAtPoint(
            view,
            embed,
            deco.from,
            deco.to,
            targetClientX,
            (rect.top + rect.bottom) / 2,
            false,
          );
          if (resolved !== null) {
            destOffset = resolved;
            break;
          }
        }
        continue;
      }
      const mathSegs = scanInlineMathVisibleSegments(slice, deco.from);
      if (mathSegs && mathSegs.some((s) => s.text.length > 0)) {
        if (destOffset >= deco.from && destOffset < deco.to) {
          const firstVisible = mathSegs.find((s) => s.text.length > 0)!;
          destOffset = firstVisible.from;
          break;
        }
      }
    }
  }

  const finalPos = {
    line: cur.line,
    ch: Math.max(0, Math.min(destLine.length, destOffset - destLine.from)),
  };
  state.goalHead = finalPos;
  return {
    position: finalPos,
    lastHPos: finalPos.ch,
    lastHSPos: state.goalColumn,
  };
}

interface PendingClick {
  decoFrom: number;
  decoTo: number;
  targetOffset: number;
  doc: object;
  x: number;
  y: number;
  moved: boolean;
  expiresAt: number;
}

interface ClickTracker {
  pending?: PendingClick;
}

export interface LivePreviewClickOptions {
  isActive(): boolean;
  isLivePreview(view: EditorView): boolean;
  isInsertMode(view: EditorView): boolean;
}

function findHtmlDecorationAtDomPos(
  view: EditorView,
  embed: HTMLElement,
  domPos: number,
): ReplaceDecoInfo | null {
  const line = view.state.doc.lineAt(Math.max(0, Math.min(domPos, view.state.doc.length)));
  const from = Math.max(line.from, domPos - 1);
  const to = Math.min(line.to, domPos + 1);
  const candidates = collectLineReplaceDecorations(view, line.from, line.to).filter(
    (d) => d.widget && d.from <= to && d.to >= from,
  );
  if (candidates.length === 0) return null;
  const embedText = embed.textContent ?? "";
  let exactFromMatch: ReplaceDecoInfo | null = null;
  for (const cand of candidates) {
    const segs = scanHtmlVisibleSegments(view.state.doc.sliceString(cand.from, cand.to), cand.from);
    if (!segs) continue;
    if (cand.from === domPos && segs.map((s) => s.text).join("") === embedText) return cand;
    if (cand.from === domPos && !exactFromMatch) exactFromMatch = cand;
  }
  return exactFromMatch ?? candidates.find((c) => c.from <= domPos && domPos <= c.to) ?? null;
}

/** Intercept `.cm-html-embed` clicks in Obsidian Live Preview so the cursor lands on the clicked text. */
export function createLivePreviewClickExtension(options: LivePreviewClickOptions): Extension {
  const stateTrackers = new WeakMap<object, ClickTracker>();

  const plugin = ViewPlugin.fromClass(
    class {
      readonly tracker: ClickTracker = {};
      private readonly onPointerDown: (event: PointerEvent) => void;
      private readonly onPointerMove: (event: PointerEvent) => void;
      private readonly onKeyDown: () => void;

      constructor(readonly view: EditorView) {
        stateTrackers.set(view.state, this.tracker);
        const ownerWin = view.dom.ownerDocument.defaultView;
        this.onPointerDown = (event: PointerEvent) => {
          this.tracker.pending = undefined;
          if (!options.isActive() || !options.isLivePreview(this.view)) return;
          if (event.isPrimary === false || event.button !== 0 || event.detail > 1) return;
          if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
          const node = event.target as Node | null;
          const element =
            ownerWin && node instanceof ownerWin.Element ? node : (node?.parentElement ?? null);
          if (!element || !this.view.contentDOM.contains(element)) return;
          const embed = element.closest(".cm-html-embed");
          if (!(ownerWin && embed instanceof ownerWin.HTMLElement)) return;
          const interactive = element.closest(
            "a, button, input, select, textarea, summary, label, [contenteditable='true']",
          );
          if (interactive && embed.contains(interactive)) return;
          let domPos: number;
          try {
            domPos = this.view.posAtDOM(embed);
          } catch {
            return;
          }
          const deco = findHtmlDecorationAtDomPos(this.view, embed, domPos);
          if (!deco) return;
          const targetOffset = resolveHtmlWidgetOffsetAtPoint(
            this.view,
            embed,
            deco.from,
            deco.to,
            event.clientX,
            event.clientY,
            options.isInsertMode(this.view),
          );
          if (targetOffset === null) return;
          this.tracker.pending = {
            decoFrom: deco.from,
            decoTo: deco.to,
            targetOffset,
            doc: this.view.state.doc,
            x: event.clientX,
            y: event.clientY,
            moved: false,
            expiresAt: Date.now() + 600,
          };
        };
        this.onPointerMove = (event: PointerEvent) => {
          const pending = this.tracker.pending;
          if (!pending || pending.moved) return;
          if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 4) {
            pending.moved = true;
          }
        };
        this.onKeyDown = () => {
          this.tracker.pending = undefined;
        };
        view.dom.addEventListener("pointerdown", this.onPointerDown, true);
        view.dom.addEventListener("pointermove", this.onPointerMove, true);
        view.dom.addEventListener("keydown", this.onKeyDown, true);
      }

      update(update: ViewUpdate): void {
        stateTrackers.set(update.state, this.tracker);
        if (update.docChanged) this.tracker.pending = undefined;
      }

      destroy(): void {
        this.tracker.pending = undefined;
        this.view.dom.removeEventListener("pointerdown", this.onPointerDown, true);
        this.view.dom.removeEventListener("pointermove", this.onPointerMove, true);
        this.view.dom.removeEventListener("keydown", this.onKeyDown, true);
      }
    },
  );

  const filter = EditorState.transactionFilter.of((tr) => {
    const tracker = stateTrackers.get(tr.startState);
    const pending = tracker?.pending;
    if (!pending) return tr;
    if (pending.moved || Date.now() > pending.expiresAt || pending.doc !== tr.startState.doc) {
      tracker.pending = undefined;
      return tr;
    }
    if (tr.docChanged || !tr.selection || tr.selection.ranges.length !== 1) return tr;
    const sel = tr.selection.main;
    const matchesEmptyBoundary =
      sel.empty && (sel.head === pending.decoFrom || sel.head === pending.decoTo);
    const matchesExactEmbedRange =
      !sel.empty && sel.from === pending.decoFrom && sel.to === pending.decoTo;
    if (matchesEmptyBoundary || matchesExactEmbedRange) {
      tracker.pending = undefined;
      return [
        tr,
        {
          selection: EditorSelection.cursor(pending.targetOffset),
          annotations: Transaction.addToHistory.of(false),
        },
      ];
    }
    if (!sel.empty) {
      tracker.pending = undefined;
      return tr;
    }
    return tr;
  });

  return [plugin, filter];
}
