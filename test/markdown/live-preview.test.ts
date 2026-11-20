import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  StateField,
  type Extension,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { buildMarkdownEditingIndex } from "../../src/markdown/editing";
import {
  createLivePreviewClickExtension,
  isLivePreviewView,
  livePreviewCharacter,
  livePreviewContentStart,
  livePreviewWord,
  projectCollapsedLine,
  projectCanonicalLine,
  resolveLiveDisplayVerticalMotion,
  resolveLiveVerticalMotion,
  resolveHtmlWidgetOffsetAtPoint,
  scanCanonicalInlineHiddenRanges,
  scanHtmlVisibleSegments,
  scanInlineMathVisibleSegments,
  type DisplayVerticalGoalState,
  type SourceRange,
  type VerticalGoalState,
} from "../../src/markdown/live-preview";
import {
  budouxSegmenter,
  createWordProvider,
  moveBigWord,
  WordBoundaryCache,
  type WordDocument,
} from "../../src/word";

class HtmlEmbedWidget extends WidgetType {
  constructor(
    private readonly html: string,
    private readonly rectProvider?: (el: HTMLElement) => void,
  ) {
    super();
  }
  override eq(other: HtmlEmbedWidget): boolean {
    return this.html === other.html && !this.rectProvider && !other.rectProvider;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-html-embed";
    span.innerHTML = this.html;
    this.rectProvider?.(span);
    return span;
  }
}

class PlainWidget extends WidgetType {
  constructor(private readonly label = "X") {
    super();
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.textContent = this.label;
    return span;
  }
}

interface SpecDeco {
  from: number;
  to: number;
  widget?: WidgetType;
}

const cleanups: (() => void)[] = [];

beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  document.body.replaceChildren();
});

function createWordDoc(text: string): WordDocument {
  const lines = text.split("\n");
  return {
    firstLine: () => 0,
    lastLine: () => lines.length - 1,
    getLine: (n) => lines[n] ?? "",
  };
}

function createView(
  doc: string,
  options: {
    anchor?: number;
    livePreview?: boolean;
    tableCell?: boolean;
    decos?: (state: EditorState) => SpecDeco[];
    extensions?: Extension[];
  } = {},
): EditorView {
  const outer = document.createElement("div");
  if (options.livePreview !== false) outer.className = "markdown-source-view is-live-preview";
  const host = options.tableCell ? document.createElement("div") : outer;
  if (options.tableCell) {
    host.className = "cm-table-widget";
    outer.appendChild(host);
  }
  document.body.appendChild(outer);

  const decoField = options.decos
    ? StateField.define<DecorationSet>({
        create: (state) => buildDecos(options.decos!(state)),
        update: (value, tr) => {
          if (tr.docChanged || tr.selection) return buildDecos(options.decos!(tr.state));
          return value;
        },
        provide: (field) => EditorView.decorations.from(field),
      })
    : [];

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: options.anchor ?? 0 },
      extensions: [decoField, ...(options.extensions ?? [])],
    }),
  });
  cleanups.push(() => {
    view.destroy();
    outer.remove();
  });
  return view;
}

function buildDecos(items: SpecDeco[]): DecorationSet {
  const sorted = [...items].sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const item of sorted) {
    builder.add(item.from, item.to, Decoration.replace(item.widget ? { widget: item.widget } : {}));
  }
  return builder.finish();
}

function viewAsWordDoc(view: EditorView): WordDocument {
  return {
    firstLine: () => 0,
    lastLine: () => view.state.doc.lines - 1,
    getLine: (n) => view.state.doc.line(n + 1).text,
  };
}

describe("live-preview pure scanners and WORD helper", () => {
  it("parses HTML tags, nested markup, quoted '>', comments, entities, void/style/script tags, and rejects invalid forms", () => {
    expect(scanHtmlVisibleSegments("<ins>hello</ins>", 10)).toEqual([
      { text: "hello", from: 15, to: 20 },
    ]);
    expect(
      scanHtmlVisibleSegments("<span data-x=\"a>b\" title='c>d'><b>hi</b>!</span>", 0),
    ).toEqual([
      { text: "hi", from: 34, to: 36 },
      { text: "!", from: 40, to: 41 },
    ]);
    expect(scanHtmlVisibleSegments("<u>&amp;&lt;&#65;&#x3042;</u>")).toEqual([
      { text: "&", from: 3, to: 8 },
      { text: "<", from: 8, to: 12 },
      { text: "A", from: 12, to: 17 },
      { text: "あ", from: 17, to: 25 },
    ]);
    expect(scanHtmlVisibleSegments("<!-- comment -->")).toEqual([]);
    expect(scanHtmlVisibleSegments("<span>a<!-- hidden -->b<br>c</span>")).toEqual([
      { text: "a", from: 6, to: 7 },
      { text: "b", from: 22, to: 23 },
      { text: "c", from: 27, to: 28 },
    ]);
    expect(
      scanHtmlVisibleSegments("<ins>a<style>p{color:red}</style><script>x=1</script>b</ins>"),
    ).toEqual([
      { text: "a", from: 5, to: 6 },
      { text: "b", from: 53, to: 54 },
    ]);
    expect(scanHtmlVisibleSegments("plain text")).toBeNull();
    expect(scanHtmlVisibleSegments("<123>no</123>")).toBeNull();
    expect(scanHtmlVisibleSegments("<ins unclosed")).toBeNull();
  });

  it("parses inline math segments and ignores invalid math delimiters", () => {
    expect(scanInlineMathVisibleSegments("$x+y$", 4)).toEqual([{ text: "x+y", from: 5, to: 8 }]);
    expect(scanInlineMathVisibleSegments("$$a+b$$", 2)).toEqual([{ text: "a+b", from: 4, to: 7 }]);
    expect(scanInlineMathVisibleSegments("$a$b$")).toBeNull();
    expect(scanInlineMathVisibleSegments("$")).toBeNull();
    expect(scanInlineMathVisibleSegments("abc")).toBeNull();
  });

  it("scans canonical inline hidden ranges with backtick/HTML literal immunity", () => {
    const code = "`<ins>x</ins> **b**`";
    expect(scanCanonicalInlineHiddenRanges(code, 0)).toEqual([
      { from: 0, to: 1 },
      { from: code.length - 1, to: code.length },
    ]);

    const html = "<ins>**b**</ins>";
    expect(scanCanonicalInlineHiddenRanges(html, 0)).toEqual([
      { from: 0, to: 5 },
      { from: 10, to: 16 },
    ]);

    const line = "[[target|alias]] [txt](https://x) **b** ==h== ~~s~~ $m$ foo_bar_baz";
    const hidden = scanCanonicalInlineHiddenRanges(line, 0);
    const vis = buildVisible(line, hidden);
    expect(vis).toBe("alias txt b h s m foo_bar_baz");
  });

  it("moves across whitespace-delimited WORDs (W/B/E/gE) including punctuation, Japanese, and lines", () => {
    const doc = createWordDoc("foo-bar 日本語、次\n\nbaz");
    expect(moveBigWord(doc, { line: 0, ch: 0 }, { repeat: 1, forward: true })).toEqual({
      line: 0,
      ch: 8,
    });
    expect(
      moveBigWord(doc, { line: 0, ch: 0 }, { repeat: 1, forward: true, wordEnd: true }),
    ).toEqual({
      line: 0,
      ch: 6,
    });
    expect(moveBigWord(doc, { line: 0, ch: 8 }, { repeat: 1, forward: false })).toEqual({
      line: 0,
      ch: 0,
    });
    expect(
      moveBigWord(doc, { line: 2, ch: 0 }, { repeat: 1, forward: false, wordEnd: true }),
    ).toEqual({
      line: 1,
      ch: 0,
    });
    expect(
      moveBigWord(doc, { line: 2, ch: 0 }, { repeat: 2, forward: false, wordEnd: true }),
    ).toEqual({
      line: 0,
      ch: 12,
    });
  });
});

function buildVisible(text: string, ranges: readonly SourceRange[]): string {
  let out = "";
  let at = 0;
  for (const r of ranges) {
    out += text.slice(at, r.from);
    at = r.to;
  }
  return out + text.slice(at);
}

describe("CM6 Live Preview projection and motions", () => {
  it("projects empty replace delimiters, HTML widgets, math widgets, opaque widgets, and empty-tag-only lines", () => {
    const doc = ["**b** <ins>hi</ins> $x+y$ [w]", "<ins></ins>", "- <ins></ins>"].join("\n");
    const l1 = doc.indexOf("\n") + 1;
    const l2 = doc.lastIndexOf("\n") + 1;
    const view = createView(doc, {
      decos: () => [
        { from: 0, to: 2 },
        { from: 3, to: 5 },
        { from: 6, to: 19, widget: new HtmlEmbedWidget("<ins>hi</ins>") },
        { from: 20, to: 25, widget: new PlainWidget("x+y") },
        { from: 26, to: 29, widget: new PlainWidget("chk") },
        { from: l1, to: l1 + 11, widget: new HtmlEmbedWidget("<ins></ins>") },
        { from: l2 + 2, to: l2 + 13, widget: new HtmlEmbedWidget("<ins></ins>") },
      ],
    });

    const p0 = projectCollapsedLine(view, 0, 0);
    expect(p0.visibleText).toBe("b hi x+y \uFFFC");
    expect(p0.emptySpans).toEqual([]);
    expect(p0.srcChAtGraphemeColumn(2)).toBe(11);
    expect(p0.srcChAtGraphemeColumn(5)).toBe(21);

    const p1 = projectCollapsedLine(view, 1, 0);
    expect(p1.visibleText).toBe("");
    expect(p1.emptySpans).toEqual([{ from: 0, to: 11 }]);
    expect(p1.visToSrcCh(0)).toBe(0);

    const p2 = projectCollapsedLine(view, 2, 2);
    expect(p2.visibleText).toBe("");
    expect(p2.emptySpans).toEqual([{ from: 2, to: 13 }]);
    expect(p2.visToSrcCh(0)).toBe(2);

    expect(isLivePreviewView(view)).toBe(true);
    const tableView = createView("cell", { tableCell: true });
    expect(isLivePreviewView(tableView)).toBe(false);
  });

  it("handles h/l initial collapsed entry, expanded 1-char editing, empty tags, and never enters closing **", () => {
    const cache = new WordBoundaryCache(64, 32768, true, budouxSegmenter);
    const provider = createWordProvider(cache);

    // Non-empty <ins> collapsed until entered, then expands and allows 1-char editing
    const doc1 = "abc<ins>def</ins>ghi";
    const view1 = createView(doc1, {
      anchor: 0,
      decos: (state) => {
        const cur = state.selection.main.head;
        if (cur >= 3 && cur < 17) return [];
        return [{ from: 3, to: 17, widget: new HtmlEmbedWidget("<ins>def</ins>") }];
      },
    });
    const src1 = viewAsWordDoc(view1);
    let head = { line: 0, ch: 2 };
    head = livePreviewCharacter(view1, src1, head, true, 1, provider);
    expect(head).toEqual({ line: 0, ch: 8 });
    view1.dispatch({ selection: { anchor: head.ch } });
    // Now expanded: h steps 1 char into </ins> / <ins>
    head = livePreviewCharacter(view1, src1, head, false, 1, provider);
    expect(head).toEqual({ line: 0, ch: 7 });

    // Backward l/h from 'g' (ch 17) lands on 'f' (ch 10)
    view1.dispatch({ selection: { anchor: 17 } });
    expect(livePreviewCharacter(view1, src1, { line: 0, ch: 17 }, false, 1, provider)).toEqual({
      line: 0,
      ch: 10,
    });

    // Trailing empty tag abc<ins></ins>: l from 'c' enters 3
    const docEmptyTrail = "abc<ins></ins>";
    const viewTrail = createView(docEmptyTrail, {
      decos: () => [{ from: 3, to: 14, widget: new HtmlEmbedWidget("<ins></ins>") }],
    });
    expect(
      livePreviewCharacter(
        viewTrail,
        viewAsWordDoc(viewTrail),
        { line: 0, ch: 2 },
        true,
        1,
        provider,
      ),
    ).toEqual({ line: 0, ch: 3 });

    // Leading empty tag <ins></ins>abc: h from 'a' (ch 11, vis 0) enters 0
    const docEmptyLead = "<ins></ins>abc";
    const viewLead = createView(docEmptyLead, {
      decos: () => [{ from: 0, to: 11, widget: new HtmlEmbedWidget("<ins></ins>") }],
    });
    expect(
      livePreviewCharacter(
        viewLead,
        viewAsWordDoc(viewLead),
        { line: 0, ch: 11 },
        false,
        1,
        provider,
      ),
    ).toEqual({ line: 0, ch: 0 });

    // Empty-tag-only line stays inside line bounds on l
    const viewOnlyEmpty = createView("<ins></ins>", {
      decos: () => [{ from: 0, to: 11, widget: new HtmlEmbedWidget("<ins></ins>") }],
    });
    expect(
      livePreviewCharacter(
        viewOnlyEmpty,
        viewAsWordDoc(viewOnlyEmpty),
        { line: 0, ch: 0 },
        true,
        1,
        provider,
      ),
    ).toEqual({ line: 0, ch: 0 });

    // Closing ** must NEVER be entered by l at last visible char
    const viewBold = createView("abc**def**", {
      decos: () => [
        { from: 3, to: 5 },
        { from: 8, to: 10 },
      ],
    });
    expect(
      livePreviewCharacter(
        viewBold,
        viewAsWordDoc(viewBold),
        { line: 0, ch: 7 },
        true,
        1,
        provider,
      ),
    ).toEqual({ line: 0, ch: 7 });

    // Grapheme combining mark + emoji inside HTML
    const docGrapheme = "か\u3099<ins>👍🏽a</ins>";
    const viewGrapheme = createView(docGrapheme, {
      decos: () => [
        {
          from: 2,
          to: docGrapheme.length,
          widget: new HtmlEmbedWidget("<ins>👍🏽a</ins>"),
        },
      ],
    });
    const nextG = livePreviewCharacter(
      viewGrapheme,
      viewAsWordDoc(viewGrapheme),
      { line: 0, ch: 0 },
      true,
      1,
      provider,
    );
    expect(nextG).toEqual({ line: 0, ch: 7 });
    const nextG2 = livePreviewCharacter(
      viewGrapheme,
      viewAsWordDoc(viewGrapheme),
      nextG,
      true,
      1,
      provider,
    );
    expect(nextG2).toEqual({ line: 0, ch: 11 });
  });

  it("supports w/b/e/ge/W/B/E/gE and ^ across collapsed HTML/Markdown/Japanese spans", () => {
    const cache = new WordBoundaryCache(64, 32768, true, budouxSegmenter);
    const provider = createWordProvider(cache);
    const doc = "- <ins>今日は良い天気</ins> **next**";
    const insFrom = doc.indexOf("<ins>");
    const insTo = doc.indexOf("</ins>") + "</ins>".length;
    const boldFrom = doc.indexOf("**");
    const boldTo = doc.lastIndexOf("**");
    const view = createView(doc, {
      decos: () => [
        { from: insFrom, to: insTo, widget: new HtmlEmbedWidget("<ins>今日は良い天気</ins>") },
        { from: boldFrom, to: boldFrom + 2 },
        { from: boldTo, to: boldTo + 2 },
      ],
    });
    const src = viewAsWordDoc(view);

    // ^ skips collapsed <ins>
    expect(livePreviewContentStart(view, 0, 2)).toBe(doc.indexOf("今"));

    // w from '-' moves across segmented Japanese inside collapsed <ins>, then to 'next' inside **next**
    const w1 = livePreviewWord(
      view,
      src,
      { line: 0, ch: 0 },
      { repeat: 1, forward: true },
      provider,
      cache,
    );
    expect(w1).toEqual({ line: 0, ch: doc.indexOf("今") });
    const w2 = livePreviewWord(view, src, w1, { repeat: 1, forward: true }, provider, cache);
    expect(w2).toEqual({ line: 0, ch: doc.indexOf("良") });
    const wAfterJp = livePreviewWord(
      view,
      src,
      { line: 0, ch: doc.indexOf("天") },
      { repeat: 1, forward: true },
      provider,
      cache,
    );
    expect(wAfterJp).toEqual({ line: 0, ch: doc.indexOf("next") });

    // b from 'next' steps back into '天' inside <ins>
    expect(
      livePreviewWord(view, src, wAfterJp, { repeat: 1, forward: false }, provider, cache),
    ).toEqual({ line: 0, ch: doc.indexOf("天") });

    // W from ch 0 jumps to '今', then directly over Japanese WORD to 'next'
    const bw1 = livePreviewWord(
      view,
      src,
      { line: 0, ch: 0 },
      { repeat: 1, forward: true, bigWord: true },
      provider,
      cache,
    );
    expect(bw1).toEqual({ line: 0, ch: doc.indexOf("今") });
    const bw2 = livePreviewWord(
      view,
      src,
      bw1,
      { repeat: 1, forward: true, bigWord: true },
      provider,
      cache,
    );
    expect(bw2).toEqual({ line: 0, ch: doc.indexOf("next") });

    // Expanded <ins> does not skip tags on ^
    const viewExpanded = createView("<ins>abc</ins>", { decos: () => [] });
    expect(livePreviewContentStart(viewExpanded, 0, 0)).toBe(0);
  });

  it("resolves j/k across <ins>, **, wikilinks, list prefixes, $j, goal preservation, off-viewport canonical fallback, and code immunity", () => {
    const text = [
      "---",
      "title: x",
      "---",
      "abcdefghij",
      "<ins>0123456789</ins>",
      "- ab**cdef**gh",
      "[[target|0123456789]]",
      "```",
      "<ins>0123456789</ins>",
      "```",
    ].join("\n");
    const index = buildMarkdownEditingIndex(text);
    const view = createView(text, {
      decos: (state) => {
        const headLine = state.doc.lineAt(state.selection.main.head).number - 1;
        const result: SpecDeco[] = [];
        const addLine = (ln: number, build: (from: number) => SpecDeco[]) => {
          if (ln === headLine) return;
          result.push(...build(state.doc.line(ln + 1).from));
        };
        addLine(4, (f) => [
          { from: f, to: f + 19, widget: new HtmlEmbedWidget("<ins>0123456789</ins>") },
        ]);
        addLine(5, (f) => [
          { from: f + 4, to: f + 6 },
          { from: f + 10, to: f + 12 },
        ]);
        addLine(6, (f) => [
          { from: f, to: f + 9 },
          { from: f + 19, to: f + 21 },
        ]);
        return result;
      },
    });
    const doc = viewAsWordDoc(view);
    const indexFromPos = (pos: { line: number; ch: number }) =>
      view.state.doc.line(pos.line + 1).from + pos.ch;

    const state: VerticalGoalState = {};
    // From line 3 col 4 ('e') -> line 4 <ins>0123456789</ins> lands on '4' (ch 9)
    const r1 = resolveLiveVerticalMotion({
      view,
      doc,
      index,
      indexFromPos,
      head: { line: 3, ch: 4 },
      forward: true,
      repeat: 1,
      state,
    });
    expect(r1.position).toEqual({ line: 4, ch: 9 });

    // Move CM6 selection to line 4 ch 9 (which expands line 4!), then j to line 5 (- ab**cdef**gh)
    // Expanded line 4 canonical projection still knows col 4 -> line 5 body col 4 ('e' is at index 8 inside **cdef**)
    view.dispatch({ selection: { anchor: indexFromPos(r1.position) } });
    const r2 = resolveLiveVerticalMotion({
      view,
      doc,
      index,
      indexFromPos,
      head: r1.position,
      forward: true,
      repeat: 1,
      state,
      lastHPos: r1.lastHPos,
    });
    expect(r2.position).toEqual({ line: 5, ch: 8 });

    // j from line 5 to line 6 ([[target|0123456789]]) lands on '4' (ch 13)
    view.dispatch({ selection: { anchor: indexFromPos(r2.position) } });
    const r3 = resolveLiveVerticalMotion({
      view,
      doc,
      index,
      indexFromPos,
      head: r2.position,
      forward: true,
      repeat: 1,
      state,
      lastHPos: r2.lastHPos,
    });
    expect(r3.position).toEqual({ line: 6, ch: 13 });

    // $j from line 3 lands on last visible grapheme '9' (ch 18 inside [[target|0123456789]]), NOT ']'
    const endState: VerticalGoalState = {};
    const rEnd = resolveLiveVerticalMotion({
      view,
      doc,
      index,
      indexFromPos,
      head: { line: 3, ch: 9 },
      forward: true,
      repeat: 3,
      state: endState,
      lastHPos: Infinity,
    });
    expect(rEnd.position).toEqual({ line: 6, ch: 18 });

    // Code block line (line 8) stays blocked -> keeps raw ch 4 ('>' or raw source offset 4)
    const rCode = resolveLiveVerticalMotion({
      view,
      doc,
      index,
      indexFromPos,
      head: { line: 7, ch: 2 },
      forward: true,
      repeat: 1,
      state: {},
    });
    expect(rCode.position).toEqual({ line: 8, ch: 2 });

    // Canonical projection directly (simulating off-viewport) ignores decorators
    const offProj = projectCanonicalLine("**hello**", 0, false);
    expect(offProj.srcChAtGraphemeColumn(2)).toBe(4);
    expect(projectCanonicalLine("**hello**", 0, true).srcChAtGraphemeColumn(2)).toBe(2);
  });

  it("resolves gj/gk inside .cm-html-embed, past boundary ** delimiters, and inside inline math", () => {
    const doc = ["abcdef", "**<ins>def</ins>**", "**hi**", "$x+y$"].join("\n");
    const l1 = doc.indexOf("\n") + 1;
    const l2 = doc.indexOf("**hi**");
    const l3 = doc.indexOf("$x+y$");

    let embedEl: HTMLElement | undefined;
    const view = createView(doc, {
      decos: () => [
        { from: l1, to: l1 + 2 },
        {
          from: l1 + 2,
          to: l1 + 16,
          widget: new HtmlEmbedWidget("<ins>def</ins>", (el) => {
            embedEl = el;
            el.getBoundingClientRect = () => new DOMRect(100, 20, 30, 16);
          }),
        },
        { from: l1 + 16, to: l1 + 18 },
        { from: l2, to: l2 + 2 },
        { from: l2 + 4, to: l2 + 6 },
        { from: l3, to: l3 + 5, widget: new PlainWidget("x+y") },
      ],
    });
    view.contentDOM.getBoundingClientRect = () => new DOMRect(100, 0, 400, 200);
    view.coordsForChar = (offset) => {
      if (offset < l1) return new DOMRect(100 + offset * 10, 0, 10, 16);
      return new DOMRect(100, 40, 10, 16);
    };
    view.coordsAtPos = (offset) => {
      if (offset >= l1 && offset < l2) return new DOMRect(100, 20, 1, 16);
      return new DOMRect(100, 40, 1, 16);
    };

    const origCreateRange = document.createRange.bind(document);
    const origCreateRangeSpy = document.createRange;
    document.createRange = () => {
      const range = origCreateRange();
      const origSetStart = range.setStart.bind(range);
      let startOffset = 0;
      range.setStart = (node, offset) => {
        startOffset = offset;
        origSetStart(node, offset);
      };
      range.getClientRects = () =>
        [new DOMRect(100 + startOffset * 10, 20, 10, 16)] as unknown as DOMRectList;
      return range;
    };
    cleanups.push(() => {
      document.createRange = origCreateRangeSpy;
    });

    // From line 0 col 1 ('b', x=10px from contentLeft) -> findPosV lands at deco.from (ch 0 of **<ins>def</ins>**).
    // Display resolver skips opening ** and resolves 'e' inside <ins>def</ins> via DOM rects!
    expect(embedEl).toBeTruthy();
    const state: DisplayVerticalGoalState = {};
    const resHtml = resolveLiveDisplayVerticalMotion({
      view,
      doc: viewAsWordDoc(view),
      head: { line: 0, ch: 1 },
      forward: true,
      repeat: 1,
      state,
      findPosV: (head) => ({ line: head.line + 1, ch: 0 }),
      charCoords: () => ({ left: 10 }),
    });
    expect(resHtml.position).toEqual({ line: 1, ch: 8 }); // 'e' in <ins>def</ins>

    // Landing on closing ** at EOL (line 2 ch 4) backs up to 'i' (ch 3)
    const resTrailDelim = resolveLiveDisplayVerticalMotion({
      view,
      doc: viewAsWordDoc(view),
      head: { line: 1, ch: 8 },
      forward: true,
      repeat: 1,
      state: {},
      findPosV: () => ({ line: 2, ch: 4 }),
      charCoords: () => ({ left: 30 }),
    });
    expect(resTrailDelim.position).toEqual({ line: 2, ch: 3 });

    // Landing on $x+y$ (line 3 ch 0) jumps past '$' to 'x' (ch 1)
    const resMath = resolveLiveDisplayVerticalMotion({
      view,
      doc: viewAsWordDoc(view),
      head: { line: 2, ch: 1 },
      forward: true,
      repeat: 1,
      state: {},
      findPosV: () => ({ line: 3, ch: 0 }),
      charCoords: () => ({ left: 10 }),
    });
    expect(resMath.position).toEqual({ line: 3, ch: 1 });
  });

  it("rewrites .cm-html-embed clicks on Normal, Insert right-half, and ignores drags, links, inactive and Source mode", () => {
    let active = true;
    let live = true;
    let insert = false;
    const text = 'prefix <ins>abcdef <a href="#x">link</a></ins>';
    const embedStart = text.indexOf("<ins>");
    const view = createView(text, {
      extensions: [
        createLivePreviewClickExtension({
          isActive: () => active,
          isLivePreview: () => live,
          isInsertMode: () => insert,
        }),
      ],
      decos: () => [
        {
          from: embedStart,
          to: text.length,
          widget: new HtmlEmbedWidget('abcdef <a href="#x">link</a>'),
        },
      ],
    });

    const embed = view.contentDOM.querySelector(".cm-html-embed") as HTMLElement;
    expect(embed).toBeTruthy();
    const insNode = embed.firstChild!;
    view.posAtDOM = (node) => (node === embed ? embedStart : 0);

    const origCreateRange = document.createRange.bind(document);
    const origCreateRangeProp = document.createRange;
    document.createRange = () => {
      const range = origCreateRange();
      let startOffset = 0;
      const origSetStart = range.setStart.bind(range);
      range.setStart = (node, offset) => {
        startOffset = offset;
        origSetStart(node, offset);
      };
      range.getClientRects = () =>
        nodeRectForOffset(range.startContainer, startOffset) as unknown as DOMRectList;
      return range;
    };
    function nodeRectForOffset(node: Node, offset: number): DOMRect[] {
      if (node === insNode) return [new DOMRect(100 + offset * 10, 10, 10, 16)];
      return [new DOMRect(200 + offset * 10, 10, 10, 16)];
    }
    cleanups.push(() => {
      document.createRange = origCreateRangeProp;
    });

    expect(
      resolveHtmlWidgetOffsetAtPoint(view, embed, embedStart, text.length, 132, 18, false),
    ).toBe(embedStart + 5 + 3);
    const pd = new PointerEvent("pointerdown", {
      bubbles: true,
      isPrimary: true,
      button: 0,
      detail: 1,
      clientX: 132,
      clientY: 18,
    });
    expect(pd.clientX).toBe(132);
    embed.dispatchEvent(pd);
    view.dispatch({ selection: EditorSelection.cursor(embedStart) });
    expect(view.state.selection.main.head).toBe(embedStart + 5 + 3); // '<ins>' (5) + 'd' (3)

    // Obsidian 1.15.1 dispatches an exact embed-range selection { anchor: decoTo, head: decoFrom };
    // verify it rewrites to an empty cursor at 'd', whereas unrelated range selections are left intact.
    view.dispatch({ selection: EditorSelection.cursor(0) });
    embed.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        isPrimary: true,
        button: 0,
        detail: 1,
        clientX: 132,
        clientY: 18,
      }),
    );
    view.dispatch({ selection: EditorSelection.range(text.length, embedStart) });
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(embedStart + 5 + 3);

    view.dispatch({ selection: EditorSelection.cursor(0) });
    embed.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        isPrimary: true,
        button: 0,
        detail: 1,
        clientX: 132,
        clientY: 18,
      }),
    );
    view.dispatch({ selection: EditorSelection.range(0, 5) });
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(5);

    // Drag > 4px cancels pending rewrite
    view.dispatch({ selection: EditorSelection.cursor(0) });
    embed.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        isPrimary: true,
        button: 0,
        detail: 1,
        clientX: 132,
        clientY: 18,
      }),
    );
    embed.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: 145, clientY: 18 }),
    );
    view.dispatch({ selection: EditorSelection.cursor(embedStart) });
    expect(view.state.selection.main.head).toBe(embedStart);

    // Click inside <a> link does not rewrite
    view.dispatch({ selection: EditorSelection.cursor(0) });
    const link = embed.querySelector("a")!;
    link.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        isPrimary: true,
        button: 0,
        detail: 1,
        clientX: 205,
        clientY: 18,
      }),
    );
    view.dispatch({ selection: EditorSelection.cursor(embedStart) });
    expect(view.state.selection.main.head).toBe(embedStart);

    // Insert mode click on right half of 'd' (clientX = 138) lands AFTER 'd'
    view.dispatch({ selection: EditorSelection.cursor(0) });
    insert = true;
    embed.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        isPrimary: true,
        button: 0,
        detail: 1,
        clientX: 138,
        clientY: 18,
      }),
    );
    view.dispatch({ selection: EditorSelection.cursor(embedStart) });
    expect(view.state.selection.main.head).toBe(embedStart + 5 + 4);

    // Source mode / inactive ignored
    view.dispatch({ selection: EditorSelection.cursor(0) });
    insert = false;
    live = false;
    embed.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        isPrimary: true,
        button: 0,
        detail: 1,
        clientX: 132,
        clientY: 18,
      }),
    );
    view.dispatch({ selection: EditorSelection.cursor(embedStart) });
    expect(view.state.selection.main.head).toBe(embedStart);

    view.dispatch({ selection: EditorSelection.cursor(0) });
    live = true;
    active = false;
    embed.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        isPrimary: true,
        button: 0,
        detail: 1,
        clientX: 132,
        clientY: 18,
      }),
    );
    view.dispatch({ selection: EditorSelection.cursor(embedStart) });
    expect(view.state.selection.main.head).toBe(embedStart);
  });
});
