import { EditorView, type Decoration, type DecorationSet } from "@codemirror/view";
import { segmentGraphemes, type WordDocument, type WordPosition } from "../word";
import {
  mergeRanges,
  scanCanonicalInlineHiddenRanges,
  scanHtmlVisibleSegments,
  scanInlineMathVisibleSegments,
  type SourceRange,
  type VisibleSegment,
} from "./live-preview-scan";

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

export interface ReplaceDecoInfo {
  from: number;
  to: number;
  widget: unknown;
}

export function collectLineReplaceDecorations(
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

  const graphemes = [...segmentGraphemes(visibleText)].map((part) => part.index);

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

export function projectOriginLine(
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
