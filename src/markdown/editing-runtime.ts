import { Vim } from "@replit/codemirror-vim";
import type { ActionArgs, CodeMirrorV, Pos, vimState } from "@replit/codemirror-vim-core";
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
}

const configurations = new WeakMap<object, Configuration>();

function active(cm: EditingMirror): boolean {
  return configurations.get(cm)?.enabled === true && !!cm.cm6 && cm.getEditingView?.() === cm.cm6;
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
  const edit = markdownOpenLine(documentIndex(cm), cm.indexFromPos(cm.getCursor()), !!args.after);
  if (!edit) return false;
  // Apply original-document coordinates from the end. Prefixes are inserted
  // before upstream starts recording Insert text, so dot does not duplicate them.
  for (const change of [...edit.changes].sort((a, b) => b.from - a.from || b.to - a.to))
    cm.replaceRange(change.insert, cm.posFromIndex(change.from), cm.posFromIndex(change.to));
  api.enterInsert(cm.posFromIndex(edit.cursor));
  return true;
}

/** Augment builtin actions without replacing their edit/repeat metadata. */
export function configureMarkdownEditing(editor: object, enabled: boolean): void {
  const cm = editor as EditingMirror;
  if (!cm.state) return;
  const current = configurations.get(cm);
  if (current) {
    current.enabled = enabled;
    return;
  }
  const previous = cm.state.lindvimeraTarget;
  const delegate: ActionDelegate = {
    ...previous,
    action(name, args, vim, api) {
      return (
        handleAction(cm, name, args, vim, api) || previous?.action?.(name, args, vim, api) || false
      );
    },
  };
  configurations.set(cm, { enabled, previous, delegate });
  cm.state.lindvimeraTarget = delegate;
}

export function clearMarkdownEditing(editor: object): void {
  const cm = editor as EditingMirror;
  const current = configurations.get(cm);
  if (current && cm.state.lindvimeraTarget === current.delegate)
    cm.state.lindvimeraTarget = current.previous;
  configurations.delete(cm);
}

export function installMarkdownEditingMotion(): void {
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
