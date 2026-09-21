import { loadDefaultJapaneseParser } from "budoux";
import { expandWordObject } from "./text-object";

export interface WordPosition {
  line: number;
  ch: number;
}

export interface WordDocument {
  getLine(line: number): string;
  firstLine(): number;
  lastLine(): number;
}

export interface WordSpan {
  from: number;
  to: number;
  last: number;
}

/** Synchronous token offsets into the unchanged input, measured in UTF-16. */
export interface JapaneseSegmenter {
  readonly id: string;
  segment(text: string): readonly { from: number; to: number }[];
}

export interface WordObjectOptions {
  inclusive?: boolean;
  innerWord?: boolean;
  repeat?: number;
  bigWord?: boolean;
  /** Vim's inclusive endpoints, before conversion to an editor selection. */
  visualSelection?: { anchor: WordPosition; head: WordPosition };
}

interface AnalyzedLine {
  words: WordSpan[];
  graphemes: number[];
}

interface FoundWord extends WordSpan {
  line: number;
}

export interface WordProvider {
  move(
    document: WordDocument,
    cursor: WordPosition,
    args: { repeat: number; forward?: boolean; wordEnd?: boolean },
  ): WordPosition;
  expand(
    document: WordDocument,
    cursor: WordPosition,
    options: WordObjectOptions,
  ): { start: WordPosition; end: WordPosition } | null;
  character(document: WordDocument, cursor: WordPosition, direction: -1 | 0 | 1): WordPosition;
}

const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
// This is the upstream CM6 adapter's word classification, applied to whole graphemes.
const legacyWord = /[\w\p{Alphabetic}\p{Number}_]/u;
const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
const parser = loadDefaultJapaneseParser();
export const budouxSegmenter: JapaneseSegmenter = {
  id: "budoux",
  segment(text) {
    let offset = 0;
    return parser.parse(text).map((chunk) => {
      const from = offset;
      offset += chunk.length;
      return { from, to: offset };
    });
  },
};

function lowerBound(values: readonly number[], value: number): number {
  let start = 0;
  let end = values.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (values[middle] < value) start = middle + 1;
    else end = middle;
  }
  return start;
}

function nonWhitespaceRuns(
  text: string,
  graphemes: readonly number[],
): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  let from: number | undefined;
  for (let index = 0; index < graphemes.length; index++) {
    const at = graphemes[index];
    const whitespace = index === graphemes.length - 1 || /\s/u.test(text.charAt(at));
    if (whitespace && from !== undefined) {
      runs.push({ from, to: at });
      from = undefined;
    } else if (!whitespace && from === undefined) from = at;
  }
  return runs;
}

/** A line-text LRU: unchanged lines survive edits, without retaining entire notes. */
export class WordBoundaryCache {
  private readonly lines = new Map<string, AnalyzedLine>();
  private readonly characterLines = new Map<string, number[]>();
  private retainedCharacters = 0;
  private retainedGraphemeCharacters = 0;
  readonly metrics = { analyses: 0, modelCalls: 0, cacheHits: 0 };

  constructor(
    readonly maximumLines = 512,
    readonly maximumCharacters = 262_144,
    readonly useJapanese = true,
    readonly japaneseSegmenter: JapaneseSegmenter = budouxSegmenter,
  ) {
    if (maximumLines < 1 || maximumCharacters < 1)
      throw new Error("Cache limits must be positive.");
  }

  get size(): number {
    return this.lines.size;
  }

  get characters(): number {
    return this.retainedCharacters;
  }

  clear(): void {
    this.lines.clear();
    this.characterLines.clear();
    this.retainedCharacters = 0;
    this.retainedGraphemeCharacters = 0;
  }

  /** Character navigation must never initialize or invoke the word model. */
  graphemes(text: string): number[] {
    const hit = this.characterLines.get(text);
    if (hit) {
      this.characterLines.delete(text);
      this.characterLines.set(text, hit);
      return hit;
    }
    const result = [...segmenter.segment(text)].map((part) => part.index);
    result.push(text.length);
    if (text.length <= this.maximumCharacters) {
      while (
        this.characterLines.size >= this.maximumLines ||
        this.retainedGraphemeCharacters + text.length > this.maximumCharacters
      ) {
        const oldest = this.characterLines.keys().next().value;
        if (oldest === undefined) break;
        this.characterLines.delete(oldest);
        this.retainedGraphemeCharacters -= oldest.length;
      }
      this.characterLines.set(text, result);
      this.retainedGraphemeCharacters += text.length;
    }
    return result;
  }

  analyze(text: string): AnalyzedLine {
    const hit = this.lines.get(text);
    if (hit) {
      this.metrics.cacheHits++;
      this.lines.delete(text);
      this.lines.set(text, hit);
      return hit;
    }
    this.metrics.analyses++;
    const graphemes = this.graphemes(text);
    const words: WordSpan[] = [];
    const add = (from: number, to: number) => {
      if (to > from) words.push({ from, to, last: graphemes[lowerBound(graphemes, to) - 1] });
    };
    for (const { from, to } of nonWhitespaceRuns(text, graphemes)) {
      const run = text.slice(from, to);
      const predicted = new Set<number>();
      if (this.useJapanese && japanese.test(run)) {
        this.metrics.modelCalls++;
        // Analyze the complete run first, preserving punctuation as model context.
        for (const chunk of this.japaneseSegmenter.segment(run)) {
          predicted.add(from + chunk.from);
          predicted.add(from + chunk.to);
        }
      }
      let start = from;
      let previousClass: boolean | undefined;
      for (let i = lowerBound(graphemes, from); graphemes[i] < from + run.length; i++) {
        const at = graphemes[i];
        const wordClass = legacyWord.test(text.slice(at, graphemes[i + 1]));
        const asciiContinuation =
          /[\w]/u.test(text.charAt(at - 1)) && /[\w]/u.test(text.charAt(at));
        // Only whole graphemes can be boundaries. Consecutive symbols are one
        // Vim word even when the model would split them into separate tokens.
        if (
          previousClass !== undefined &&
          (previousClass !== wordClass || (wordClass && !asciiContinuation && predicted.has(at)))
        ) {
          add(start, at);
          start = at;
        }
        previousClass = wordClass;
      }
      add(start, from + run.length);
    }
    const result = { words, graphemes };
    if (text.length <= this.maximumCharacters) {
      while (
        this.lines.size >= this.maximumLines ||
        this.retainedCharacters + text.length > this.maximumCharacters
      ) {
        const oldest = this.lines.keys().next().value;
        if (oldest === undefined) break;
        this.lines.delete(oldest);
        this.retainedCharacters -= oldest.length;
      }
      this.lines.set(text, result);
      this.retainedCharacters += text.length;
    }
    return result;
  }
}

const sharedCache = new WordBoundaryCache();

/** UTF-16 half-open spans for a decoded table cell or other plain-text input. */
export function wordSpans(text: string, bigWord = false, cache = sharedCache): readonly WordSpan[] {
  if (!bigWord) return cache.analyze(text).words;
  const graphemes = cache.graphemes(text);
  return nonWhitespaceRuns(text, graphemes).map(({ from, to }) => {
    return { from, to, last: graphemes[lowerBound(graphemes, to) - 1] };
  });
}

export function createWordProvider(cache = new WordBoundaryCache()): WordProvider {
  const character: WordProvider["character"] = (document, cursor, direction) => {
    // Linewise operators may use the position just after the final document line.
    if (cursor.line < document.firstLine() || cursor.line > document.lastLine())
      return { ...cursor };
    const text = document.getLine(cursor.line);
    const boundaries = cache.graphemes(text);
    const index = lowerBound(boundaries, Math.max(0, Math.min(cursor.ch, text.length)));
    const exact = boundaries[index] === cursor.ch;
    let ch: number;
    if (direction < 0) ch = boundaries[Math.max(0, index - 1)];
    else if (direction > 0) {
      ch = cursor.ch >= text.length ? cursor.ch + 1 : boundaries[exact ? index + 1 : index];
    } else ch = boundaries[exact ? index : Math.max(0, index - 1)];
    return { line: cursor.line, ch };
  };

  function find(
    document: WordDocument,
    cursor: WordPosition,
    forward: boolean,
    emptyLineIsWord: boolean,
  ): FoundWord | null {
    const direction = forward ? 1 : -1;
    for (
      let line = cursor.line;
      line >= document.firstLine() && line <= document.lastLine();
      line += direction
    ) {
      const text = document.getLine(line);
      if (!text && emptyLineIsWord && line !== cursor.line) {
        return { line, from: 0, to: 0, last: 0 };
      }
      const current = line === cursor.line;
      const position = current ? character(document, cursor, 0).ch : forward ? 0 : text.length;
      const words = cache.analyze(text).words;
      if (forward) {
        for (const word of words) {
          if (word.to <= position) continue;
          const start = Math.max(position, word.from);
          if (current && start === position && position === word.last) continue;
          return { ...word, from: start, line };
        }
      } else {
        for (let index = words.length - 1; index >= 0; index--) {
          const word = words[index];
          if (word.from > position) continue;
          if (current && position === word.from) continue;
          return { ...word, to: Math.min(position, word.last), line };
        }
      }
    }
    return null;
  }

  return {
    character,
    move(document, cursor, args) {
      const forward = !!args.forward;
      const wordEnd = !!args.wordEnd;
      const origin = { ...cursor };
      const repeat = Math.max(1, args.repeat) + Number(forward !== wordEnd);
      const words: FoundWord[] = [];
      for (let index = 0; index < repeat; index++) {
        const word = find(document, cursor, forward, !(forward && wordEnd));
        if (!word) {
          const line = forward ? document.lastLine() : document.firstLine();
          const end = forward ? document.getLine(line).length : 0;
          words.push({ line, from: end, to: end, last: end });
          break;
        }
        words.push(word);
        cursor = { line: word.line, ch: forward ? word.last : word.from };
      }
      const shortCircuit = words.length !== repeat;
      const first = words[0];
      let last = words.at(-1)!;
      if (
        !shortCircuit &&
        ((forward && !wordEnd && (first.from !== origin.ch || first.line !== origin.line)) ||
          (!forward && wordEnd && (first.to !== origin.ch || first.line !== origin.line)))
      ) {
        last = words.at(-2)!;
      }
      return { line: last.line, ch: wordEnd ? (forward ? last.last : last.to) : last.from };
    },
    expand(document, cursor, options) {
      return expandWordObject(document, cursor, options, cache);
    },
  };
}

/** Install on a CM5-compatible Vim adapter; each editor owns its own bounded cache. */
export function installWordProvider(
  cm: { state: { wordBoundaryProvider?: WordProvider } },
  cache = new WordBoundaryCache(),
): () => void {
  const previous = cm.state.wordBoundaryProvider;
  const provider = createWordProvider(cache);
  cm.state.wordBoundaryProvider = provider;
  return () => {
    if (cm.state.wordBoundaryProvider === provider) cm.state.wordBoundaryProvider = previous;
    cache.clear();
  };
}
