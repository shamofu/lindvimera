import { Vim } from "@replit/codemirror-vim";
import type { EditorView } from "@codemirror/view";
import type { ActionArgs, CodeMirrorV, Pos, vimState, MotionFn } from "@replit/codemirror-vim-core";
import { createWordProvider, WordBoundaryCache, type WordProvider } from "../word";
import {
  buildMarkdownEditingIndex,
  markdownContentStart,
  markdownOpenLine,
  type MarkdownEditingIndex,
} from "./editing";
import {
  livePreviewCharacter,
  livePreviewContentStart,
  livePreviewWord,
  resolveLiveDisplayVerticalMotion,
  resolveLiveVerticalMotion,
  type DisplayVerticalGoalState,
  type VerticalGoalState,
} from "./live-preview";

interface InsertAPI {
  enterInsert(head?: Pos): void;
  exitVisual(): void;
}
interface ActionDelegate {
  action?(name: string, args: ActionArgs, vim: vimState, api: InsertAPI): boolean;
  evaluateInput?(
    input: { motion?: string; operator?: string },
    api: InsertAPI & { defaultMotion(): unknown },
  ): boolean;
}
/** Host operations stay native: Smart Lists, folds, and numbering belong to Obsidian. */
export interface MarkdownEditingHost {
  smartLists(): boolean;
  livePreview(): boolean;
  enter(): boolean;
  indent(more: boolean): boolean;
}
type EditingMirror = Omit<CodeMirrorV, "cm6" | "getEditingView" | "state"> & {
  cm6?: EditorView;
  getEditingView?: () => EditorView;
  state: {
    lindvimeraTarget?: ActionDelegate;
    wordBoundaryProvider?: WordProvider;
    vim?: vimState;
  };
};
interface Configuration {
  enabled: boolean;
  previous?: ActionDelegate;
  delegate: ActionDelegate;
  revision?: object;
  text?: string;
  index?: MarkdownEditingIndex;
  host?: MarkdownEditingHost;
  verticalState: VerticalGoalState;
  displayState: DisplayVerticalGoalState;
  restore(): void;
}

const configurations = new WeakMap<object, Configuration>();
const fallbackCache = new WordBoundaryCache(64, 32_768, true);
const fallbackWords = createWordProvider(fallbackCache);

function body(cm: EditingMirror): boolean {
  return !!cm.cm6 && cm.getEditingView?.() === cm.cm6;
}
function active(cm: EditingMirror): boolean {
  return configurations.get(cm)?.enabled === true && body(cm);
}

function documentIndex(cm: EditingMirror): MarkdownEditingIndex {
  const configuration = configurations.get(cm)!;
  const revision = cm.cm6?.state.doc;
  if (configuration.index && revision && configuration.revision === revision)
    return configuration.index;
  const text = cm.getValue();
  if (!configuration.index || configuration.text !== text) {
    configuration.index = buildMarkdownEditingIndex(text);
    configuration.text = text;
  }
  configuration.revision = revision;
  return configuration.index;
}

function handleAction(
  cm: EditingMirror,
  name: string,
  args: ActionArgs,
  vim: vimState,
  api: InsertAPI,
): boolean {
  if (!active(cm) || vim.visualMode || cm.getOption("readOnly")) return false;
  if (name === "enterInsertMode" && args.insertAt === "firstNonBlank") {
    const offset = markdownContentStart(documentIndex(cm), cm.indexFromPos(cm.getCursor()));
    if (offset === undefined) return false;
    api.enterInsert(cm.posFromIndex(offset));
    return true;
  }
  if (name !== "newLineAndEnterInsertMode") return false;
  const host = configurations.get(cm)?.host;
  if (host && args.after) {
    const head = cm.getCursor();
    cm.setCursor({ line: head.line, ch: cm.getLine(head.line).length });
    // This also handles Smart Lists OFF: let the same host keymap choose its fallback.
    if (host.enter()) {
      api.enterInsert(cm.getCursor());
      return true;
    }
    return false;
  }
  const edit = markdownOpenLine(
    documentIndex(cm),
    cm.indexFromPos(cm.getCursor()),
    !!args.after,
    !host,
  );
  if (!edit) return false;
  // Apply original-document coordinates from the end. Prefixes are inserted
  // before upstream starts recording Insert text, so dot does not duplicate them.
  for (const change of [...edit.changes].sort((a, b) => b.from - a.from || b.to - a.to))
    cm.replaceRange(change.insert, cm.posFromIndex(change.from), cm.posFromIndex(change.to));
  api.enterInsert(cm.posFromIndex(edit.cursor));
  return true;
}

/** Augment builtin actions without replacing their edit/repeat metadata. */
export function configureMarkdownEditing(
  editor: object,
  enabled: boolean,
  host?: MarkdownEditingHost,
): void {
  const cm = editor as EditingMirror;
  if (!cm.state) return;
  const current = configurations.get(cm);
  if (current) {
    current.enabled = enabled;
    current.host = host;
    current.verticalState.goal = undefined;
    current.verticalState.goalHead = undefined;
    current.displayState.goalColumn = undefined;
    current.displayState.goalCenterBias = undefined;
    current.displayState.goalHead = undefined;
    return;
  }
  const previous = cm.state.lindvimeraTarget;
  const delegate: ActionDelegate = {
    ...previous,
    action(name, args, vim, api) {
      const configuration = configurations.get(cm)!;
      configuration.verticalState.goal = undefined;
      configuration.verticalState.goalHead = undefined;
      configuration.displayState.goalColumn = undefined;
      configuration.displayState.goalCenterBias = undefined;
      configuration.displayState.goalHead = undefined;
      return (
        handleAction(cm, name, args, vim, api) || previous?.action?.(name, args, vim, api) || false
      );
    },
    evaluateInput(input, api) {
      const configuration = configurations.get(cm)!;
      if (input.motion !== "lindvimeraContentVertical") {
        configuration.verticalState.goal =
          input.motion === "moveToEol" && !input.operator ? Infinity : undefined;
        configuration.verticalState.goalHead = undefined;
      }
      if (input.motion !== "lindvimeraDisplayVertical") {
        configuration.displayState.goalColumn = undefined;
        configuration.displayState.goalCenterBias = undefined;
        configuration.displayState.goalHead = undefined;
      }
      return previous?.evaluateInput?.(input, api) ?? false;
    },
  };
  const nativeInput = cm.nativeInputHandler;
  const indentMore = cm.indentMore;
  const indentLess = cm.indentLess;
  const input: typeof nativeInput = (key) =>
    (active(cm) && key === "Enter" && configurations.get(cm)?.host?.enter()) ||
    nativeInput?.(key) ||
    false;
  const more = () => {
    if (!(active(cm) && configurations.get(cm)?.host?.indent(true))) indentMore.call(cm);
  };
  const less = () => {
    if (!(active(cm) && configurations.get(cm)?.host?.indent(false))) indentLess.call(cm);
  };
  cm.nativeInputHandler = input;
  cm.indentMore = more;
  cm.indentLess = less;
  configurations.set(cm, {
    enabled,
    host,
    previous,
    delegate,
    verticalState: {},
    displayState: {},
    restore() {
      if (cm.nativeInputHandler === input) cm.nativeInputHandler = nativeInput;
      if (cm.indentMore === more) cm.indentMore = indentMore;
      if (cm.indentLess === less) cm.indentLess = less;
    },
  });
  cm.state.lindvimeraTarget = delegate;
}

export function clearMarkdownEditing(editor: object): void {
  const cm = editor as EditingMirror;
  const current = configurations.get(cm);
  if (current && cm.state.lindvimeraTarget === current.delegate)
    cm.state.lindvimeraTarget = current.previous;
  current?.restore();
  configurations.delete(cm);
}

export function installMarkdownEditingMotion(): void {
  const vertical: MotionFn = (editor, head, args, vim) => {
    const cm = editor as EditingMirror;
    const configuration = configurations.get(cm)!;
    const result = resolveLiveVerticalMotion({
      view: cm.cm6,
      doc: cm,
      index: documentIndex(cm),
      indexFromPos: (position) => cm.indexFromPos(position),
      head,
      forward: !!args.forward,
      repeat: args.repeat,
      state: configuration.verticalState,
      findPosV: (from, amount, unit, horizontal) => cm.findPosV(from, amount, unit, horizontal),
      charCoords: (position, mode) => cm.charCoords(position, mode),
      lastHPos: vim.lastHPos,
      lastHSPos: vim.lastHSPos,
    });
    vim.lastHPos = result.lastHPos;
    if (result.lastHSPos !== undefined) vim.lastHSPos = result.lastHSPos;
    return result.position;
  };
  Vim.defineMotion("lindvimeraContentVertical", vertical);
  for (const [key, forward] of [
    ["j", true],
    ["k", false],
  ] as const) {
    for (const context of ["normal", "visual"] as const)
      Vim.mapCommand(
        key,
        "motion",
        "lindvimeraContentVertical",
        { forward, linewise: true },
        {
          context,
          when: (editor: CodeMirrorV) =>
            body(editor) &&
            !editor.state.vim?.visualBlock &&
            configurations.get(editor)?.host?.livePreview() === true,
        },
      );
  }

  const displayVertical: MotionFn = (editor, head, args, vim) => {
    const cm = editor as EditingMirror;
    const configuration = configurations.get(cm)!;
    const view = cm.getEditingView?.() ?? cm.cm6;
    if (!view)
      return cm.findPosV(head, (args.forward ? 1 : -1) * args.repeat, "line", vim.lastHSPos);
    const result = resolveLiveDisplayVerticalMotion({
      view,
      doc: cm,
      head,
      forward: !!args.forward,
      repeat: args.repeat,
      state: configuration.displayState,
      findPosV: (from, amount, unit, horizontal) => cm.findPosV(from, amount, unit, horizontal),
      charCoords: (position, mode) => cm.charCoords(position, mode),
      lastHSPos: vim.lastHSPos,
    });
    vim.lastHPos = result.lastHPos;
    if (result.lastHSPos !== undefined) vim.lastHSPos = result.lastHSPos;
    return result.position;
  };
  Vim.defineMotion("lindvimeraDisplayVertical", displayVertical);
  for (const [key, forward] of [
    ["gj", true],
    ["gk", false],
  ] as const) {
    for (const context of ["normal", "visual"] as const)
      Vim.mapCommand(
        key,
        "motion",
        "lindvimeraDisplayVertical",
        { forward },
        {
          context,
          when: (editor: CodeMirrorV) =>
            body(editor) &&
            !editor.state.vim?.visualBlock &&
            configurations.get(editor)?.host?.livePreview() === true,
        },
      );
  }

  Vim.defineMotion("lindvimeraLiveCharacter", (editor, head, args, vim, input) => {
    const cm = editor as EditingMirror;
    const view = cm.getEditingView?.() ?? cm.cm6;
    const provider = cm.state.wordBoundaryProvider ?? fallbackWords;
    let target: Pos;
    if (!view) {
      target = head;
      for (let i = 0; i < args.repeat; i++)
        target = provider.character(cm, target, args.forward ? 1 : -1);
    } else {
      target = livePreviewCharacter(view, cm, head, !!args.forward, args.repeat, provider);
    }
    if (!input?.operator) vim.lastHPos = target.ch;
    return target;
  });
  for (const [key, forward] of [
    ["h", false],
    ["l", true],
  ] as const) {
    for (const context of ["normal", "visual"] as const)
      Vim.mapCommand(
        key,
        "motion",
        "lindvimeraLiveCharacter",
        { forward },
        {
          context,
          when: (editor: CodeMirrorV) =>
            body(editor) &&
            !editor.state.vim?.visualBlock &&
            configurations.get(editor)?.host?.livePreview() === true,
        },
      );
  }

  Vim.defineMotion("lindvimeraLiveWord", (editor, head, args, vim, input) => {
    const cm = editor as EditingMirror;
    const view = cm.getEditingView?.() ?? cm.cm6;
    const provider = cm.state.wordBoundaryProvider ?? fallbackWords;
    const target = !view
      ? provider.move(cm, head, {
          repeat: args.repeat,
          forward: args.forward,
          wordEnd: args.wordEnd,
        })
      : livePreviewWord(
          view,
          cm,
          head,
          {
            repeat: args.repeat,
            forward: args.forward,
            wordEnd: args.wordEnd,
            bigWord: args.bigWord,
          },
          provider,
          fallbackCache,
        );
    if (!input?.operator) vim.lastHPos = target.ch;
    return target;
  });
  for (const [key, forward, wordEnd, bigWord] of [
    ["w", true, false, false],
    ["b", false, false, false],
    ["e", true, true, false],
    ["ge", false, true, false],
    ["W", true, false, true],
    ["B", false, false, true],
    ["E", true, true, true],
    ["gE", false, true, true],
  ] as const) {
    for (const context of ["normal", "visual"] as const)
      Vim.mapCommand(
        key,
        "motion",
        "lindvimeraLiveWord",
        { forward, wordEnd, inclusive: wordEnd, ...(bigWord ? { bigWord: true } : {}) },
        {
          context,
          when: (editor: CodeMirrorV) =>
            body(editor) &&
            !editor.state.vim?.visualBlock &&
            configurations.get(editor)?.host?.livePreview() === true,
        },
      );
  }

  Vim.defineMotion("lindvimeraContentStart", (editor, head, _args, vim, input) => {
    const cm = editor as EditingMirror;
    // Recorded c^ motions also use this fallback after settings/target changes.
    const offset = active(cm)
      ? markdownContentStart(documentIndex(cm), cm.indexFromPos(head))
      : undefined;
    if (offset === undefined) {
      const line = cm.getLine(head.line);
      const first = line.search(/\S/);
      let start: Pos = { line: head.line, ch: first === -1 ? line.length : first };
      if (
        first !== -1 &&
        !input?.operator &&
        !vim.visualBlock &&
        body(cm) &&
        configurations.get(cm)?.host?.livePreview() === true
      ) {
        const view = cm.getEditingView?.() ?? cm.cm6;
        if (view) {
          start = { line: start.line, ch: livePreviewContentStart(view, start.line, start.ch) };
          vim.lastHPos = start.ch;
        }
      }
      return start;
    }
    let start = cm.posFromIndex(offset);
    if (
      !input?.operator &&
      !vim.visualBlock &&
      body(cm) &&
      configurations.get(cm)?.host?.livePreview() === true
    ) {
      const view = cm.getEditingView?.() ?? cm.cm6;
      if (view)
        start = { line: start.line, ch: livePreviewContentStart(view, start.line, start.ch) };
    }
    // Normal/Visual have no character at EOL. An empty body has no motion or
    // operator range; I can still enter at the insertion point above.
    if (start.ch === cm.getLine(start.line).length) return;
    if (!input?.operator) vim.lastHPos = start.ch;
    return start;
  });
  Vim.mapCommand(
    "^",
    "motion",
    "lindvimeraContentStart",
    {},
    {
      // Keep the ^-specific motion in the edit record even while disabled or in a cell.
      // Its implementation resolves the live setting and target again during dot replay.
      when: (cm: CodeMirrorV) => configurations.has(cm),
    },
  );
}
