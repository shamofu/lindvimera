import type { WordBoundaryCache, WordDocument, WordPosition } from "./index";

export interface SentenceObjectOptions {
  inclusive?: boolean;
  repeat?: number;
  /** Inclusive Vim endpoints, before conversion to an editor selection. */
  visualSelection?: { anchor: WordPosition; head: WordPosition };
}

export interface SentenceProvider {
  move(
    document: WordDocument,
    cursor: WordPosition,
    options: { repeat: number; forward?: boolean },
  ): WordPosition;
  expand(
    document: WordDocument,
    cursor: WordPosition,
    options: SentenceObjectOptions,
  ): { start: WordPosition; end: WordPosition } | null;
  character(document: WordDocument, cursor: WordPosition, direction: -1 | 0 | 1): WordPosition;
}

interface Unit {
  from: number;
  to: number;
  whitespace: boolean;
}

const whitespace = /\s/u;
const standardEnd = /[.!?]/u;
const japaneseEnd = /[。！？]/u;
const standardCloser = /[\])"']/u;
const japaneseCloser = /[\])}"'」』】）］｝〉》〕〗〙〛”’]/u;

function boundaryIndex(boundaries: readonly number[], ch: number): number {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (boundaries[middle] < ch) low = middle + 1;
    else high = middle;
  }
  return low;
}

function characterPosition(
  cache: WordBoundaryCache,
  document: WordDocument,
  position: WordPosition,
  direction: -1 | 0 | 1,
): WordPosition {
  if (position.line < document.firstLine() || position.line > document.lastLine())
    return { ...position };
  const text = document.getLine(position.line);
  const boundaries = cache.graphemes(text);
  const ch = Math.min(text.length, Math.max(0, position.ch));
  let index = boundaryIndex(boundaries, ch);
  if (direction < 0 || (direction === 0 && boundaries[index] !== ch)) index--;
  else if (direction > 0 && boundaries[index] === ch) index++;
  return { line: position.line, ch: boundaries[Math.max(0, index)] ?? text.length + 1 };
}

/** One immutable view of the active editing target; cells use their decoded text. */
class SentenceDocument {
  readonly text: string;
  readonly offsets: number[] = [];
  readonly lines: string[] = [];
  readonly units: Unit[] = [];
  readonly blankRuns: { from: number; to: number }[] = [];

  constructor(
    readonly document: WordDocument,
    private readonly cache: WordBoundaryCache,
  ) {
    let offset = 0;
    for (let line = document.firstLine(); line <= document.lastLine(); line++) {
      const text = document.getLine(line);
      this.offsets.push(offset);
      this.lines.push(text);
      offset += text.length + 1;
    }
    this.text = this.lines.join("\n");
    let paragraph = 0;
    for (let line = 0; line < this.lines.length; line++) {
      if (this.lines[line] !== "") continue;
      this.scanParagraph(paragraph, this.offsets[line]);
      const from = this.offsets[line];
      while (line + 1 < this.lines.length && this.lines[line + 1] === "") line++;
      this.blankRuns.push({ from, to: this.offsets[line] });
      paragraph = this.offsets[line] + 1;
    }
    this.scanParagraph(paragraph, this.text.length);
    // Whitespace is itself an inner sentence object. Around objects combine it
    // with a neighbouring sentence, while inner counts traverse both kinds.
    let end = 0;
    const sentences = this.units.splice(0);
    for (const sentence of sentences) {
      if (sentence.from > end) this.units.push({ from: end, to: sentence.from, whitespace: true });
      this.units.push(sentence);
      end = sentence.to;
    }
    if (end < this.text.length)
      this.units.push({ from: end, to: this.text.length, whitespace: true });
  }

  private scanParagraph(from: number, to: number): void {
    const isEnd = (character: string) =>
      standardEnd.test(character) || (this.cache.useJapanese && japaneseEnd.test(character));
    const closer = this.cache.useJapanese ? japaneseCloser : standardCloser;
    while (from < to && whitespace.test(this.text[from])) {
      const next = this.nextBoundary(from + 1);
      if (!/^\s+$/u.test(this.text.slice(from, next))) break;
      from = next;
    }
    for (let index = from; index < to; index++) {
      if (!isEnd(this.text[index])) continue;
      let end = index;
      let japanese = false;
      while (end < to && isEnd(this.text[end])) {
        japanese ||= this.cache.useJapanese && japaneseEnd.test(this.text[end]);
        end = this.nextBoundary(end + 1);
      }
      while (end < to && closer.test(this.text[end])) end = this.nextBoundary(end + 1);
      if (!japanese && end < to && !whitespace.test(this.text[end])) continue;
      this.units.push({ from, to: end, whitespace: false });
      from = end;
      while (from < to && whitespace.test(this.text[from])) {
        const next = this.nextBoundary(from + 1);
        if (!/^\s+$/u.test(this.text.slice(from, next))) break;
        from = next;
      }
      index = from - 1;
    }
    while (to > from && whitespace.test(this.text[to - 1])) to--;
    if (to > from) this.units.push({ from, to, whitespace: false });
  }

  offset(position: WordPosition): number {
    const line = Math.max(
      0,
      Math.min(this.lines.length - 1, position.line - this.document.firstLine()),
    );
    return this.offsets[line] + Math.max(0, Math.min(this.lines[line].length, position.ch));
  }

  position(offset: number): WordPosition {
    offset = Math.max(0, Math.min(this.text.length, offset));
    let low = 0;
    let high = this.offsets.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.offsets[middle] <= offset) low = middle;
      else high = middle;
    }
    return { line: this.document.firstLine() + low, ch: offset - this.offsets[low] };
  }

  unitAt(offset: number): number {
    return this.units.findIndex((unit) => unit.to > offset);
  }

  private nextBoundary(offset: number): number {
    const position = this.position(offset);
    const boundaries = this.cache.graphemes(this.document.getLine(position.line));
    return (
      this.offsets[position.line - this.document.firstLine()] +
      boundaries[boundaryIndex(boundaries, position.ch)]
    );
  }
}

/** Standard ASCII sentence rules, optionally extended with Japanese punctuation. */
export function createSentenceProvider(cache: WordBoundaryCache): SentenceProvider {
  function character(
    document: WordDocument,
    cursor: WordPosition,
    direction: -1 | 0 | 1,
  ): WordPosition {
    // Endpoint conversion is line-local and never analyzes sentence boundaries.
    return characterPosition(cache, document, cursor, direction);
  }

  return {
    character,
    move(document, cursor, options) {
      const snapshot = new SentenceDocument(document, cache);
      const forward = !!options.forward;
      const stops = snapshot.units.filter((unit) => !unit.whitespace).map((unit) => unit.from);
      for (const run of snapshot.blankRuns) stops.push(forward ? run.from : run.to);
      stops.sort((left, right) => left - right);
      const offset = snapshot.offset(cursor);
      const repeat = Math.max(1, options.repeat);
      // A run of empty lines contributes its near edge only. Select counted
      // destinations directly so large counts do not repeatedly scan the note.
      const index = forward
        ? boundaryIndex(stops, offset + 1) + repeat - 1
        : boundaryIndex(stops, offset) - repeat;
      if (index < 0) return { line: document.firstLine(), ch: 0 };
      if (index >= stops.length) {
        const last = {
          line: document.lastLine(),
          ch: document.getLine(document.lastLine()).length,
        };
        return character(document, last, -1);
      }
      return snapshot.position(stops[index]);
    },
    expand(document, cursor, options) {
      const snapshot = new SentenceDocument(document, cache);
      const units = snapshot.units;
      if (!units.length) return null;
      const visual = options.visualSelection;
      const head = snapshot.offset(visual?.head ?? cursor);
      const anchor = snapshot.offset(visual?.anchor ?? cursor);
      const backwards = head < anchor;
      const extending = !!visual && head !== anchor;
      const count = Math.max(1, options.repeat ?? 1);
      const include = !!options.inclusive;
      let index = snapshot.unitAt(head);
      if (index < 0) index = units.length - 1;
      if (extending) {
        const nextHead = snapshot.offset(character(document, visual.head, 1));
        if (backwards && head === units[index].from && index > 0) index--;
        else if (!backwards && nextHead >= units[index].to && index + 1 < units.length) index++;
      }
      let first = index;
      let last = index;
      const direction = backwards ? -1 : 1;
      for (let repeat = 0; repeat < count; repeat++) {
        if (repeat) {
          const next = backwards ? first - 1 : last + 1;
          if (next < 0 || next >= units.length) break;
          if (backwards) first = next;
          else last = next;
        }
        if (!include) continue;
        const edge = backwards ? first : last;
        const next = edge + direction;
        if (next >= 0 && next < units.length && units[next].whitespace !== units[edge].whitespace) {
          if (backwards) first = next;
          else last = next;
        }
      }
      // At EOF an around sentence takes preceding whitespace instead.
      if (
        include &&
        !extending &&
        !units[last].whitespace &&
        first > 0 &&
        units[first - 1].whitespace
      )
        first--;
      let from = units[first].from;
      let to = units[last].to;
      if (extending) {
        if (backwards) to = Math.max(to, snapshot.offset(character(document, visual.anchor, 1)));
        else from = Math.min(from, anchor);
      }
      return { start: snapshot.position(from), end: snapshot.position(to) };
    },
  };
}
