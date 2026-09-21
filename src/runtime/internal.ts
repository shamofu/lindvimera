import { getCM, Vim } from "@replit/codemirror-vim";
import { DEFAULT_SETTINGS } from "../settings";
import { resolveNativeTable } from "../table/native-adapter";
import { parseMarkdownTable } from "../table/source";
import { budouxSegmenter, installWordProvider, WordBoundaryCache, wordSpans } from "../word";
import { editorSession, lindvimeraEditor } from "./editor";

/** Internal fixture contract, not a supported third-party extension API.
 * These references let the isolated harness exercise the installed bundle's
 * actual sessions and Vim state without bundling another runtime.
 */
export const internalRuntime = Object.freeze({
  version: 1 as const,
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
});

export type InternalRuntime = typeof internalRuntime;
