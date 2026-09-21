import { describe, expect, it } from "vitest";
import {
  createWordProvider,
  installWordProvider,
  WordBoundaryCache,
  wordSpans,
  type WordDocument,
} from "../../src/word";

function document(text: string): WordDocument {
  const lines = text.split("\n");
  return { getLine: (line) => lines[line], firstLine: () => 0, lastLine: () => lines.length - 1 };
}

describe("plain-text BudouX boundaries", () => {
  it("uses the bundled Japanese model without changing the text", () => {
    const text = "今日は良い天気です。明日も晴れます。";
    const words = wordSpans(text);
    expect(words.map(({ from, to }) => text.slice(from, to))).toEqual([
      "今日は",
      "良い",
      "天気です",
      "。",
      "明日も",
      "晴れます",
      "。",
    ]);
    expect(words.map(({ from, to }) => text.slice(from, to)).join("")).toBe(text);
  });

  it("keeps legacy English word/punctuation rules and uppercase WORD boundaries", () => {
    const text = "alpha-beta foo_bar //path?q=3 日本語の文節";
    expect(wordSpans(text).map(({ from, to }) => text.slice(from, to))).toEqual([
      "alpha",
      "-",
      "beta",
      "foo_bar",
      "//",
      "path",
      "?",
      "q",
      "=",
      "3",
      "日本語の",
      "文節",
    ]);
    expect(wordSpans(text, true).map(({ from, to }) => text.slice(from, to))).toEqual([
      "alpha-beta",
      "foo_bar",
      "//path?q=3",
      "日本語の文節",
    ]);
  });

  it("can provide legacy word spans when Japanese segmentation is disabled", () => {
    const text = "日本語の文節 alpha-beta";
    const cache = new WordBoundaryCache(512, 262_144, false);
    expect(wordSpans(text, false, cache).map(({ from, to }) => text.slice(from, to))).toEqual([
      "日本語の文節",
      "alpha",
      "-",
      "beta",
    ]);
    expect(cache.metrics.modelCalls).toBe(0);
  });

  it("preserves model context while adding punctuation boundaries", () => {
    const seen: string[] = [];
    const cache = new WordBoundaryCache(512, 262_144, true, {
      id: "whole-run",
      segment(text) {
        seen.push(text);
        return [{ from: 0, to: text.length }];
      },
    });
    const text = "「今日は。」https://例.jp/道?q=3";
    expect(wordSpans(text, false, cache).map(({ from, to }) => text.slice(from, to))).toEqual([
      "「",
      "今日は",
      "。」",
      "https",
      "://",
      "例",
      ".",
      "jp",
      "/",
      "道",
      "?",
      "q",
      "=",
      "3",
    ]);
    expect(seen).toEqual([text]);
  });

  it("ignores injected token boundaries inside ASCII words and graphemes", () => {
    const text = "日本foo_bar42👩🏽‍💻が!!";
    const cache = new WordBoundaryCache(512, 262_144, true, {
      id: "individual-code-units",
      segment(value) {
        return Array.from({ length: value.length }, (_, from) => ({ from, to: from + 1 }));
      },
    });
    expect(wordSpans(text, false, cache).map(({ from, to }) => text.slice(from, to))).toEqual([
      "日",
      "本",
      "foo_bar42",
      "👩🏽‍💻",
      "が",
      "!!",
    ]);
  });

  it("character navigation and WORD objects never run the Japanese model", () => {
    const cache = new WordBoundaryCache();
    const provider = createWordProvider(cache);
    const doc = document("日本語👩🏽‍💻の文章です。");
    provider.character(doc, { line: 0, ch: 0 }, 1);
    provider.character(doc, { line: 0, ch: 4 }, 0);
    provider.expand(doc, { line: 0, ch: 0 }, { innerWord: true, bigWord: true });
    expect(cache.metrics.analyses).toBe(0);
    expect(cache.metrics.modelCalls).toBe(0);
    provider.move(doc, { line: 0, ch: 0 }, { forward: true, repeat: 1 });
    expect(cache.metrics.modelCalls).toBe(1);
  });

  it("stops at sentence punctuation before the next line, without adding a plain line-end stop", () => {
    const provider = createWordProvider();
    const doc = document("今日は良い天気です。\n明日も晴れます");
    expect(provider.move(doc, { line: 0, ch: 5 }, { forward: true, repeat: 1 })).toEqual({
      line: 0,
      ch: 9,
    });
    expect(provider.move(doc, { line: 0, ch: 9 }, { forward: true, repeat: 1 })).toEqual({
      line: 1,
      ch: 0,
    });
    expect(
      provider.move(
        document("今日は良い天気です\n明日も晴れます"),
        { line: 0, ch: 5 },
        { forward: true, repeat: 1 },
      ),
    ).toEqual({ line: 1, ch: 0 });
  });

  it.each([
    "日本語が好きです。",
    "日本語👨‍👩‍👧‍👦の文章",
    "私は🍣が好きです。",
    "é 👩🏽‍💻 🇯🇵",
    " \u0301日本語",
  ])("never splits a grapheme in %s", (text) => {
    const boundaries = new Set(
      [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)].map((p) => p.index),
    );
    boundaries.add(text.length);
    for (const span of wordSpans(text)) {
      expect(boundaries.has(span.from)).toBe(true);
      expect(boundaries.has(span.to)).toBe(true);
      expect(boundaries.has(span.last)).toBe(true);
    }
  });

  it("distinguishes cursor destinations from inclusive selection ends", () => {
    const doc = document("私は🍣が好きです。");
    const provider = createWordProvider();
    expect(provider.move(doc, { line: 0, ch: 0 }, { forward: true, repeat: 1 })).toEqual({
      line: 0,
      ch: 2,
    });
    expect(provider.character(doc, { line: 0, ch: 2 }, 1)).toEqual({ line: 0, ch: 4 });
    expect(provider.character(doc, { line: 0, ch: 3 }, 0)).toEqual({ line: 0, ch: 2 });
    expect(provider.character(doc, { line: 0, ch: 4 }, -1)).toEqual({ line: 0, ch: 2 });
  });

  it("bounds both the line count and retained characters, with LRU eviction", () => {
    const cache = new WordBoundaryCache(2, 20);
    cache.analyze("日本語1");
    cache.analyze("日本語2");
    cache.analyze("日本語1");
    cache.analyze("日本語3");
    expect(cache.size).toBe(2);
    expect(cache.metrics).toEqual({ analyses: 3, cacheHits: 1, modelCalls: 3 });
    cache.analyze("日本語2");
    expect(cache.metrics.analyses).toBe(4);
    cache.analyze("日本語".repeat(100));
    expect(cache.size).toBe(2);
    expect(cache.characters).toBeLessThanOrEqual(20);
  });

  it("touches only traversed lines in a large document and reuses unchanged lines", () => {
    const cache = new WordBoundaryCache();
    const provider = createWordProvider(cache);
    const doc = document(
      Array.from({ length: 10000 }, (_, i) => `${i} 日本語の文節を操作します。`).join("\n"),
    );
    provider.move(doc, { line: 5000, ch: 5 }, { forward: true, repeat: 1 });
    expect(cache.metrics.analyses).toBe(1);
    provider.move(doc, { line: 5000, ch: 5 }, { forward: true, repeat: 1 });
    expect(cache.metrics.analyses).toBe(1);
  });

  it("installs per editor and restores the preceding provider on dispose", () => {
    const previous = createWordProvider();
    const cm = { state: { wordBoundaryProvider: previous } };
    const dispose = installWordProvider(cm);
    expect(cm.state.wordBoundaryProvider).not.toBe(previous);
    dispose();
    expect(cm.state.wordBoundaryProvider).toBe(previous);
  });
});
