// Adapted from Neovim f8cfd7f06ae87d47aac04ddce860b302f7820858, src/nvim/textobject.c.
// Copyright Neovim contributors. Original Vim portions retain the Vim license.
// Adaptations: TypeScript, UTF-16 grapheme/span traversal, per-editor state.
// See THIRD_PARTY_NOTICES.md for the complete Neovim license and adaptation notice.
import {
  wordSpans,
  type WordBoundaryCache,
  type WordDocument,
  type WordObjectOptions,
  type WordPosition,
  type WordSpan,
} from "./index";

function compare(a: WordPosition, b: WordPosition): number {
  return a.line - b.line || a.ch - b.ch;
}

/**
 * Word-object traversal uses Vim's distinct newline and empty-line positions.
 * In particular, iw counts intervening white areas, while aw counts words.
 * Behavioral oracle: Neovim v0.12.5, current_word().
 * This stays line-local so selecting one word never scans the whole note.
 */
class WordCursor {
  position: WordPosition;
  private readonly spans = new Map<number, readonly WordSpan[]>();

  constructor(
    private readonly document: WordDocument,
    position: WordPosition,
    private readonly cache: WordBoundaryCache,
    private readonly bigWord: boolean,
  ) {
    this.position = { ...position };
  }

  get text(): string {
    return this.document.getLine(this.position.line);
  }

  get empty(): boolean {
    return !this.text;
  }

  /** Zero denotes whitespace; every token has its own identity. */
  get kind(): string | 0 {
    const { line, ch } = this.position;
    let spans = this.spans.get(line);
    if (!spans) {
      spans = wordSpans(this.text, this.bigWord, this.cache);
      this.spans.set(line, spans);
    }
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (spans[middle].to <= ch) low = middle + 1;
      else high = middle;
    }
    return low < spans.length && spans[low].from <= ch ? `${line}:${low}` : 0;
  }

  /** 0: character; 1: next line; 2: line-end position; -1: document end. */
  next(skipLineEnd = false): number {
    let result: number;
    if (this.position.ch < this.text.length) {
      const boundaries = this.cache.graphemes(this.text);
      this.position.ch = boundaries[this.boundaryIndex(boundaries) + 1];
      result = this.position.ch === this.text.length ? 2 : 0;
    } else if (this.position.line < this.document.lastLine()) {
      this.position = { line: this.position.line + 1, ch: 0 };
      result = 1;
    } else result = -1;
    return skipLineEnd && result >= 1 && this.position.ch ? this.next() : result;
  }

  /** Decrement through the virtual line-end character unless explicitly skipped. */
  previous(skipLineEnd = false): number {
    if (this.position.ch > 0) {
      const boundaries = this.cache.graphemes(this.text);
      this.position.ch = boundaries[Math.max(0, this.boundaryIndex(boundaries) - 1)];
      return 0;
    }
    if (this.position.line <= this.document.firstLine()) return -1;
    this.position.line--;
    this.position.ch = this.text.length;
    return skipLineEnd && this.position.ch ? this.previous() : 1;
  }

  left(): boolean {
    if (!this.position.ch) return false;
    this.previous();
    return true;
  }

  startInLine(): void {
    const kind = this.kind;
    while (this.left()) {
      if (this.kind !== kind) {
        this.next();
        break;
      }
    }
  }

  nextStart(): boolean {
    const kind = this.kind;
    const lastLine = this.position.line === this.document.lastLine();
    let step = this.next();
    if (step < 0 || (step >= 1 && lastLine)) return false;
    if (step >= 1) return true;
    if (kind) {
      while (this.kind === kind) {
        step = this.next();
        if (step !== 0) return true;
      }
    }
    while (!this.kind && !this.empty) {
      if (this.next() !== 0) break;
    }
    return true;
  }

  end(): boolean {
    const kind = this.kind;
    if (this.next() < 0) return false;
    if (this.kind === kind && kind) {
      while (this.kind === kind) if (this.next() < 0) return false;
    } else if (!kind) {
      while (!this.kind) {
        if (this.empty) return true;
        if (this.next() < 0) return false;
      }
      const nextKind = this.kind;
      while (this.kind === nextKind) if (this.next() < 0) return false;
    }
    this.previous();
    return true;
  }

  previousStart(): boolean {
    const kind = this.kind;
    if (this.previous() < 0) return false;
    if (!kind || this.kind === kind) {
      while (!this.kind) {
        if (this.empty) return true;
        if (this.previous() < 0) return true;
      }
      const previousKind = this.kind;
      while (this.kind === previousKind) if (this.previous() < 0) return true;
    }
    this.next();
    return true;
  }

  previousEnd(): boolean {
    const kind = this.kind;
    const step = this.previous();
    if (step < 0) return false;
    if (step === 1) return true;
    if (kind) while (this.kind === kind) if (this.previous() !== 0) return true;
    while (!this.kind && !this.empty) if (this.previous() !== 0) break;
    return true;
  }

  private boundaryIndex(boundaries: readonly number[]): number {
    let low = 0;
    let high = boundaries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (boundaries[middle] < this.position.ch) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

export function expandWordObject(
  document: WordDocument,
  cursor: WordPosition,
  options: WordObjectOptions,
  cache: WordBoundaryCache,
): { start: WordPosition; end: WordPosition } | null {
  const include = !!options.inclusive;
  const visual = options.visualSelection;
  const walker = new WordCursor(document, visual?.head ?? cursor, cache, !!options.bigWord);
  let start = { ...(visual?.anchor ?? cursor) };
  let count = Math.max(1, options.repeat ?? 1);
  let includeLeadingSpace = false;
  let inclusiveEnd = true;
  let failed = false;

  if (!visual || compare(visual.head, visual.anchor) === 0) {
    walker.startInLine();
    start = { ...walker.position };
    if (!walker.kind === include) {
      if (!walker.end()) {
        if (!visual) return null;
        start = { ...visual.anchor };
        count = 0;
        failed = true;
      }
    } else {
      walker.nextStart();
      if (!walker.position.ch) walker.previous(true);
      else walker.left();
      includeLeadingSpace = include;
    }
    count--;
  }

  while (count-- > 0) {
    inclusiveEnd = true;
    if (visual && compare(walker.position, start) < 0) {
      if (walker.previous(true) < 0) {
        failed = true;
        break;
      }
      if (include !== !!walker.kind) {
        if (!walker.previousStart()) {
          failed = true;
          break;
        }
      } else {
        if (!walker.previousEnd()) {
          failed = true;
          break;
        }
        walker.next(true);
      }
    } else {
      if (walker.next(true) < 0) {
        failed = true;
        break;
      }
      if (include !== !walker.kind) {
        if (!walker.nextStart() && count > 0) {
          failed = true;
          break;
        }
        inclusiveEnd = walker.left();
      } else if (!walker.end()) {
        failed = true;
        break;
      }
    }
  }

  if (failed && !visual) return null;
  if (!failed && includeLeadingSpace && (walker.kind || (!walker.position.ch && !inclusiveEnd))) {
    const end = { ...walker.position };
    walker.position = { ...start };
    if (walker.left()) {
      walker.startInLine();
      if (!walker.kind && walker.position.ch > 0) start = { ...walker.position };
    }
    walker.position = end;
  }

  let end = { ...walker.position };
  if (compare(start, end) > 0) {
    [start, end] = [end, start];
    inclusiveEnd = true;
  }
  if (inclusiveEnd || visual) {
    walker.position = { ...end };
    if (end.ch < walker.text.length) {
      walker.next();
      end = { ...walker.position };
    } else if (visual) {
      // Vim can leave the Visual head on the virtual newline, including EOF.
      end.ch++;
    } else if (compare(start, end) !== 0 && end.line < document.lastLine()) {
      end = { line: end.line + 1, ch: 0 };
    }
  }
  return { start, end };
}
