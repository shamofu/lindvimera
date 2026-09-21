import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { getCM, Vim } from "@replit/codemirror-vim";
import { lindvimeraEditor } from "../runtime/editor";
import { DEFAULT_SETTINGS } from "../settings";
import {
  budouxSegmenter,
  installWordProvider,
  WordBoundaryCache,
  type JapaneseSegmenter,
} from "../word";

export interface EditorPerformanceMetrics {
  schemaVersion: 1;
  method: "synchronous-vim-command-dispatch";
  segmenter: string;
  note: string;
  document: { lines: number; utf16Characters: number; startingLine: number };
  commands: { count: number; pattern: readonly string[] };
  setupMs: number;
  totalCommandMs: number;
  latencyMs: { p50: number; p95: number; max: number };
  wordCache: {
    analyses: number;
    modelCalls: number;
    cacheHits: number;
    retainedLines: number;
    retainedCharacters: number;
    maximumLines: number;
    maximumCharacters: number;
  };
  documentReads: { distinctLines: number; fullTextReads: number };
  checks: {
    documentUnchanged: boolean;
    normalModePreserved: boolean;
    cacheBounded: boolean;
    noFullDocumentRead: boolean;
    localizedAnalyses: boolean;
  };
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * A real CodeMirror/runtime workload in a disposable editor in the Obsidian renderer.
 * It measures synchronous dispatch, not OS key delivery, animation frames, or paint.
 */
export function measureEditorPerformance(
  parent: HTMLElement,
  segmenter: JapaneseSegmenter = budouxSegmenter,
): EditorPerformanceMetrics {
  const started = performance.now();
  const lineCount = 12_000;
  const startingLine = 6_000;
  const commandCount = 500;
  const pattern = ["w", "w", "b", "h", "l", "e", "ge", "j"] as const;
  const samples = [
    "今日は良い天気です。明日も晴れます。 English words alpha-beta",
    "- [ ] 日本語の文節を操作します。 é 👩🏽‍💻 mixed_text",
    "## 見出しと文章 https://example.com/日本語の文節",
    "`日本語のコード` と **強調された内容** を確認します。",
    "表の外でも日本語👨‍👩‍👧‍👦の文章と英語を一緒に編集します。",
  ];
  const text = Array.from(
    { length: lineCount },
    (_, index) => `${samples[index % samples.length]} ${index}`,
  ).join("\n");
  const container = parent.ownerDocument.createElement("div");
  container.setAttribute("aria-hidden", "true");
  // Keep the editor measurable while leaving the active test view and focus intact.
  container.style.cssText =
    "position:absolute;left:-10000px;top:0;width:800px;height:160px;overflow:hidden;pointer-events:none";
  parent.append(container);
  const settings = {
    ...DEFAULT_SETTINGS,
    escapeSequences: [...DEFAULT_SETTINGS.escapeSequences],
    keyBindings: [],
    probeEnabled: false,
  };
  const cache = new WordBoundaryCache(512, 262_144, true, segmenter);
  let view: EditorView | undefined;
  let removeProvider: (() => void) | undefined;
  try {
    view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          lindvimeraEditor({ settings: () => settings, owner: () => undefined }),
        ],
      }),
    });
    const cm = getCM(view);
    if (!cm) throw new Error("Performance editor did not initialize the Vim runtime.");
    removeProvider = installWordProvider(cm, cache);
    cm.setCursor({ line: startingLine, ch: 0 });
    const readLines = new Set<number>();
    let fullTextReads = 0;
    const getLine = cm.getLine;
    const getValue = cm.getValue;
    cm.getLine = (line) => {
      readLines.add(line);
      return getLine.call(cm, line);
    };
    cm.getValue = () => {
      fullTextReads++;
      return getValue.call(cm);
    };
    const setupMs = performance.now() - started;
    const durations: number[] = [];
    try {
      for (let index = 0; index < commandCount; index++) {
        const command = pattern[index % pattern.length];
        const before = performance.now();
        for (const key of command) cm.operation(() => Vim.handleKey(cm, key, "user"));
        durations.push(performance.now() - before);
      }
    } finally {
      cm.getLine = getLine;
      cm.getValue = getValue;
    }
    const ordered = [...durations].sort((left, right) => left - right);
    const percentile = (fraction: number) =>
      rounded(ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]);
    const checks = {
      documentUnchanged: view.state.doc.toString() === text,
      normalModePreserved: !!cm.state.vim && !cm.state.vim.insertMode && !cm.state.vim.visualMode,
      cacheBounded: cache.size <= cache.maximumLines && cache.characters <= cache.maximumCharacters,
      noFullDocumentRead: fullTextReads === 0,
      localizedAnalyses:
        cache.metrics.analyses > 0 &&
        cache.metrics.analyses <= commandCount * 2 &&
        cache.metrics.analyses < lineCount / 10 &&
        readLines.size < lineCount / 10,
    };
    const metrics: EditorPerformanceMetrics = {
      schemaVersion: 1,
      method: "synchronous-vim-command-dispatch",
      segmenter: segmenter.id,
      note: "Real renderer/runtime commands; excludes OS input latency and subsequent layout/paint.",
      document: { lines: lineCount, utf16Characters: text.length, startingLine },
      commands: { count: commandCount, pattern },
      setupMs: rounded(setupMs),
      totalCommandMs: rounded(durations.reduce((sum, duration) => sum + duration, 0)),
      latencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: percentile(1) },
      wordCache: {
        ...cache.metrics,
        retainedLines: cache.size,
        retainedCharacters: cache.characters,
        maximumLines: cache.maximumLines,
        maximumCharacters: cache.maximumCharacters,
      },
      documentReads: { distinctLines: readLines.size, fullTextReads },
      checks,
    };
    const failed = Object.entries(checks).filter(([, passed]) => !passed);
    if (failed.length) {
      throw new Error(`Performance regression: ${JSON.stringify(metrics)}`);
    }
    return metrics;
  } finally {
    removeProvider?.();
    view?.destroy();
    container.remove();
  }
}
