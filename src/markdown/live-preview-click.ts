import { EditorSelection, EditorState, Transaction, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { segmentGraphemes } from "../word";
import { scanHtmlVisibleSegments } from "./live-preview-scan";
import { collectLineReplaceDecorations, type ReplaceDecoInfo } from "./live-preview-projection";

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
    for (const part of segmentGraphemes(text)) {
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
