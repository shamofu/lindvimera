import type { InternalRuntime } from "../../src/runtime/internal";

// Live bindings are initialized by the harness before any suite or view is created.
// No production implementation is imported into the harness bundle.
export let Vim: InternalRuntime["Vim"];
export let getCM: InternalRuntime["getCM"];
export let editorSession: InternalRuntime["editorSession"];
export let lindvimeraEditor: InternalRuntime["lindvimeraEditor"];
export let WordBoundaryCache: InternalRuntime["WordBoundaryCache"];
export let wordSpans: InternalRuntime["wordSpans"];
export let budouxSegmenter: InternalRuntime["budouxSegmenter"];
export let installWordProvider: InternalRuntime["installWordProvider"];
export let DEFAULT_SETTINGS: InternalRuntime["DEFAULT_SETTINGS"];
export let resolveNativeTable: InternalRuntime["resolveNativeTable"];
export let parseMarkdownTable: InternalRuntime["parseMarkdownTable"];

export function bindRuntime(candidate: unknown): InternalRuntime {
  const runtime = candidate as Partial<InternalRuntime> | undefined;
  if (!runtime || runtime.version !== 1)
    throw new Error("Unsupported Lindvimera internal runtime. The harness requires version 1.");
  for (const name of [
    "getCM",
    "editorSession",
    "lindvimeraEditor",
    "WordBoundaryCache",
    "wordSpans",
    "installWordProvider",
    "resolveNativeTable",
    "parseMarkdownTable",
  ] as const)
    if (typeof runtime[name] !== "function")
      throw new Error(`The installed Lindvimera runtime is missing ${name}.`);
  if (
    typeof runtime.Vim?.handleKey !== "function" ||
    typeof runtime.budouxSegmenter?.segment !== "function" ||
    !runtime.DEFAULT_SETTINGS
  )
    throw new Error("The installed Lindvimera runtime is incomplete.");
  const bound = runtime as InternalRuntime;
  ({
    Vim,
    getCM,
    editorSession,
    lindvimeraEditor,
    WordBoundaryCache,
    wordSpans,
    budouxSegmenter,
    installWordProvider,
    DEFAULT_SETTINGS,
    resolveNativeTable,
    parseMarkdownTable,
  } = bound);
  return bound;
}
