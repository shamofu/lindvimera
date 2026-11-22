import { EditorView, type DecorationSet } from "@codemirror/view";
import { markdownContentStart, type MarkdownEditingIndex } from "./editing";
import {
  lastCharacter,
  moveBigWord,
  type WordBoundaryCache,
  type WordDocument,
  type WordPosition,
  type WordProvider,
} from "../word";
import { scanHtmlVisibleSegments, scanInlineMathVisibleSegments } from "./live-preview-scan";
import {
  collectLineReplaceDecorations,
  createLivePreviewDocument,
  isLivePreviewView,
  projectCanonicalLine,
  projectCollapsedLine,
  projectOriginLine,
  type LineProjection,
} from "./live-preview-projection";
import { resolveHtmlWidgetOffsetAtPoint } from "./live-preview-click";

export {
  scanCanonicalInlineHiddenRanges,
  scanHtmlVisibleSegments,
  scanInlineMathVisibleSegments,
  type SourceRange,
  type VisibleSegment,
} from "./live-preview-scan";
export {
  createLivePreviewDocument,
  isLivePreviewView,
  projectCanonicalLine,
  projectCollapsedLine,
  type LineProjection,
  type LivePreviewDocument,
} from "./live-preview-projection";
export {
  createLivePreviewClickExtension,
  resolveHtmlWidgetOffsetAtPoint,
  type LivePreviewClickOptions,
} from "./live-preview-click";

export interface VerticalGoalState {
  goal?: number;
  goalHead?: WordPosition;
}

export interface DisplayVerticalGoalState {
  goalColumn?: number;
  goalCenterBias?: number;
  goalHead?: WordPosition;
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
  const lastVis = lastCharacter(proj.visibleText);
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
    const clampedVis = destProj.visibleText.length ? lastCharacter(destProj.visibleText) : 0;
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
          const prev = vis > 0 ? lastCharacter(proj.visibleText, 0, vis) : 0;
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
