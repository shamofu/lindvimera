import { Vim } from "@replit/codemirror-vim";
import type { ActionArgs, CodeMirrorV, Pos, vimState, MotionFn } from "@replit/codemirror-vim-core";
import {
  buildMarkdownEditingIndex,
  markdownContentStart,
  markdownOpenLine,
  type MarkdownEditingIndex,
} from "./editing";

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
  cm6?: { state: { doc: object } };
  getEditingView?: () => { state: { doc: object } };
  state: { lindvimeraTarget?: ActionDelegate };
};
interface Configuration {
  enabled: boolean;
  previous?: ActionDelegate;
  delegate: ActionDelegate;
  revision?: object;
  text?: string;
  index?: MarkdownEditingIndex;
  host?: MarkdownEditingHost;
  goal?: number;
  goalHead?: Pos;
  restore(): void;
}

const configurations = new WeakMap<object, Configuration>();

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
    current.goal = undefined;
    current.goalHead = undefined;
    return;
  }
  const previous = cm.state.lindvimeraTarget;
  const delegate: ActionDelegate = {
    ...previous,
    action(name, args, vim, api) {
      const configuration = configurations.get(cm)!;
      configuration.goal = undefined;
      configuration.goalHead = undefined;
      return (
        handleAction(cm, name, args, vim, api) || previous?.action?.(name, args, vim, api) || false
      );
    },
    evaluateInput(input, api) {
      const configuration = configurations.get(cm)!;
      if (input.motion !== "lindvimeraContentVertical") {
        configuration.goal = input.motion === "moveToEol" && !input.operator ? Infinity : undefined;
        configuration.goalHead = undefined;
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
    restore() {
      if (cm.nativeInputHandler === input) cm.nativeInputHandler = nativeInput;
      if (cm.indentMore === more) cm.indentMore = indentMore;
      if (cm.indentLess === less) cm.indentLess = indentLess;
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
    const index = documentIndex(cm);
    const from = markdownContentStart(index, cm.indexFromPos(head));
    const content = from === undefined ? 0 : from - cm.indexFromPos({ line: head.line, ch: 0 });
    if (
      configuration.goalHead &&
      (configuration.goalHead.line !== head.line || configuration.goalHead.ch !== head.ch)
    )
      configuration.goal = undefined;
    if (configuration.goal === undefined) configuration.goal = Math.max(0, head.ch - content);
    const amount = (args.forward ? 1 : -1) * args.repeat;
    const physical = Math.max(cm.firstLine(), Math.min(cm.lastLine(), head.line + amount));
    // findPosV is used only to skip native folded rows; j/k stay physical, while gj/gk retain display goals.
    const visible = cm.findPosV(head, amount, "line", vim.lastHSPos);
    const line = args.forward ? Math.max(physical, visible.line) : Math.min(physical, visible.line);
    const to = markdownContentStart(index, cm.indexFromPos({ line, ch: 0 }));
    const prefix = to === undefined ? 0 : to - cm.indexFromPos({ line, ch: 0 });
    const ch = Math.min(Math.max(0, cm.getLine(line).length - 1), prefix + configuration.goal);
    vim.lastHPos = ch;
    vim.lastHSPos = cm.charCoords({ line, ch }, "div").left;
    configuration.goalHead = { line, ch };
    return { line, ch };
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
            body(editor as EditingMirror) &&
            configurations.get(editor)?.host?.livePreview() === true,
        },
      );
  }
  Vim.defineMotion("lindvimeraContentStart", (editor, head) => {
    const cm = editor as EditingMirror;
    // Recorded c^ motions also use this fallback after settings/target changes.
    const offset = active(cm)
      ? markdownContentStart(documentIndex(cm), cm.indexFromPos(head))
      : undefined;
    if (offset === undefined) {
      const line = cm.getLine(head.line);
      const first = line.search(/\S/);
      return { line: head.line, ch: first === -1 ? line.length : first };
    }
    const start = cm.posFromIndex(offset);
    // Normal/Visual have no character at EOL. An empty body has no motion or
    // operator range; I can still enter at the insertion point above.
    if (start.ch === cm.getLine(start.line).length) return;
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
