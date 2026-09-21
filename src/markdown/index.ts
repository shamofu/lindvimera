import { Vim } from "@replit/codemirror-vim";
import type {
  CodeMirrorV,
  OperatorArgs,
  CM5RangeInterface,
  Pos,
} from "@replit/codemirror-vim-core";
import { indexMarkdown, markdownObject, structureMotion, type MarkdownIndex } from "./ranges";
import { findSurround, surroundText, type SurroundRange } from "./surround";
import { internalLinkAt } from "./links";

export { indexMarkdown, markdownObject, structureMotion } from "./ranges";
export { surroundPair, surroundText, findSurround, changeSurround } from "./surround";
export { internalLinkAt } from "./links";

export interface MarkdownSettings {
  motions: boolean;
  textObjects: boolean;
  surround: boolean;
  /** Open a resolved internal link in the current pane, relative to the current note. */
  openLink?: (linktext: string) => void;
}

interface SurroundArgs extends OperatorArgs {
  count?: number;
  replacement?: string;
  range?: SurroundRange;
}

interface PendingSurround {
  ranges: CM5RangeInterface[];
  args: SurroundArgs;
  operation: "add" | "change";
  document: string;
}

const settings = new WeakMap<object, MarkdownSettings>();
const indexes = new WeakMap<object, { text: string; index: MarkdownIndex; revision?: object }>();
const pending = new WeakMap<object, PendingSurround>();
let installed = false;
const graphemes = new Intl.Segmenter("ja", { granularity: "grapheme" });

function lastCharacter(text: string, from: number, to: number): number {
  let last = from;
  for (const segment of graphemes.segment(text.slice(from, to))) last = from + segment.index;
  return last;
}

export function configureMarkdown(cm: object, options: MarkdownSettings): void {
  settings.set(cm, options);
  if (!options.surround) pending.delete(cm);
}

export function clearMarkdown(cm: object): void {
  settings.delete(cm);
  indexes.delete(cm);
  pending.delete(cm);
}

/** Cancel delimiter input when the host changes the active editing target. */
export function cancelMarkdownInput(cm: CodeMirrorV): void {
  pending.delete(cm);
  cm.state.vim.expectLiteralNext = false;
}

function enabled(cm: object, feature: "motions" | "textObjects" | "surround"): boolean {
  return settings.get(cm)?.[feature] === true;
}

function documentIndex(cm: CodeMirrorV): { text: string; index: MarkdownIndex } {
  const editor: {
    cm6?: { state: { doc: object } };
    getEditingView?: () => { state: { doc: object } };
  } = cm;
  const revision = (editor.getEditingView?.() ?? editor.cm6)?.state.doc;
  let cached = indexes.get(cm);
  if (revision && cached && cached.revision === revision) return cached;
  const text = cm.getValue();
  if (!cached || cached.text !== text) {
    cached = { text, index: indexMarkdown(text), revision };
    indexes.set(cm, cached);
  }
  return cached;
}

function orderedRange(cm: CodeMirrorV, range: CM5RangeInterface): { from: number; to: number } {
  const anchor = cm.indexFromPos(range.anchor);
  const head = cm.indexFromPos(range.head);
  return { from: Math.min(anchor, head), to: Math.max(anchor, head) };
}

function applyAdd(
  cm: CodeMirrorV,
  args: SurroundArgs,
  ranges: CM5RangeInterface[],
): Pos | undefined {
  const replacement = args.replacement;
  if (!replacement) return;
  let cursor: Pos | undefined;
  for (const range of [...ranges].reverse()) {
    let { from, to } = orderedRange(cm, range);
    let content = cm.getValue().slice(from, to);
    if (args.linewise) {
      // yss surrounds line contents while retaining indentation and the final newline.
      const leading = /^\s*/.exec(content)![0].length;
      const trailing = /\s*$/.exec(content)![0].length;
      from += leading;
      to = Math.max(from, to - trailing);
      content = cm.getValue().slice(from, to);
    }
    cursor = cm.posFromIndex(from);
    cm.replaceRange(surroundText(content, replacement), cursor, cm.posFromIndex(to));
  }
  return cursor;
}

function applyChange(
  cm: CodeMirrorV,
  args: SurroundArgs,
  ranges: CM5RangeInterface[],
): Pos | undefined {
  const text = cm.getValue();
  const range =
    args.range ??
    findSurround(
      text,
      cm.indexFromPos(ranges[0].anchor),
      args.selectedCharacter ?? "",
      args.count ?? 1,
    );
  if (!range) return;
  const content = text.slice(range.inner.from, range.inner.to);
  const insert = args.replacement ? surroundText(content, args.replacement) : content;
  const cursor = cm.posFromIndex(range.outer.from);
  cm.replaceRange(insert, cursor, cm.posFromIndex(range.outer.to));
  return cursor;
}

/** Retain one target-local selection while waiting for a delimiter. */
function queueSurround(
  cm: CodeMirrorV,
  ranges: CM5RangeInterface[],
  args: SurroundArgs,
  operation: "add" | "change" = "add",
): void {
  pending.set(cm, { ranges, args, operation, document: cm.getValue() });
  cm.state.vim.expectLiteralNext = true;
}

export function installMarkdownCommands(): void {
  if (installed) return;
  installed = true;
  Vim.defineAction("lindvimeraOpenLink", (cm) => {
    const link = internalLinkAt(cm.getValue(), cm.indexFromPos(cm.getCursor()));
    if (link !== undefined) settings.get(cm)?.openLink?.(link);
  });
  Vim.mapCommand(
    "gf",
    "action",
    "lindvimeraOpenLink",
    {},
    {
      context: "normal",
      when: (cm: CodeMirrorV) => !!settings.get(cm)?.openLink,
    },
  );
  for (const [kind, suffix] of [
    ["heading", "h"],
    ["list", "l"],
  ] as const) {
    const name = `lindvimera${kind}`;
    Vim.defineMotion(name, (cm, head, args) => {
      const { text, index } = documentIndex(cm);
      const position = structureMotion(
        index,
        text,
        cm.indexFromPos(head),
        kind,
        !!args.forward,
        args.repeat,
      );
      return position === undefined ? undefined : cm.posFromIndex(position);
    });
    for (const forward of [true, false]) {
      Vim.mapCommand(
        `${forward ? "]" : "["}${suffix}`,
        "motion",
        name,
        { forward, toJumplist: true },
        {
          when: (cm: CodeMirrorV) => enabled(cm, "motions"),
        },
      );
    }
  }
  for (const kind of ["*", "_", "`", "l", "C"] as const) {
    const name = `lindvimeraObject${kind}`;
    Vim.defineMotion(name, (cm, head, args, vim) => {
      const { text, index } = documentIndex(cm);
      const range = markdownObject(
        index,
        cm.indexFromPos(head),
        kind,
        !!args.textObjectInner,
        args.repeat,
      );
      if (!range) return;
      // Operator text objects use exclusive ends; Vim's visual selection uses inclusive ends.
      const end =
        vim.visualMode && range.to > range.from
          ? cm.state.wordBoundaryProvider
            ? lastCharacter(text, range.from, range.to)
            : range.to - ((text.codePointAt(range.to - 2) ?? 0) > 0xffff ? 2 : 1)
          : range.to;
      return [cm.posFromIndex(range.from), cm.posFromIndex(end)];
    });
    for (const inner of [true, false]) {
      for (const context of ["operatorPending", "visual"]) {
        Vim.mapCommand(
          `${inner ? "i" : "a"}${kind}`,
          "motion",
          name,
          { textObjectInner: inner },
          {
            context,
            when: (cm: CodeMirrorV) => enabled(cm, "textObjects"),
          },
        );
      }
    }
  }

  Vim.defineOperator("lindvimeraSurroundAdd", (cm, args: SurroundArgs, ranges) => {
    if (args.replacement) return applyAdd(cm, args, ranges);
    queueSurround(cm, ranges, args);
    return ranges[0].anchor;
  });
  Vim.defineOperator("lindvimeraSurroundDelete", (cm, args: SurroundArgs, ranges) =>
    applyChange(cm, args, ranges),
  );
  Vim.defineOperator("lindvimeraSurroundChange", (cm, args: SurroundArgs, ranges) => {
    if (args.replacement) return applyChange(cm, args, ranges);
    queueSurround(cm, ranges, args, "change");
    return ranges[0].anchor;
  });
  for (const [operator, previous] of [
    ["Add", "yank"],
    ["Delete", "delete"],
    ["Change", "change"],
  ] as const) {
    Vim.mapCommand(
      "s",
      "operator",
      `lindvimeraSurround${operator}`,
      {},
      {
        context: "operatorPending",
        continueOperator: true,
        ...(operator === "Add" ? {} : { operatorCount: "argument" as const }),
        when: (cm: CodeMirrorV) =>
          enabled(cm, "surround") &&
          (cm.state.vim.inputState.operator === previous ||
            (operator === "Add" && cm.state.vim.inputState.operator === "lindvimeraSurroundAdd")),
      },
    );
  }
  Vim.mapCommand(
    "gS",
    "operator",
    "lindvimeraSurroundAdd",
    {},
    {
      context: "visual",
      when: (cm: CodeMirrorV) => enabled(cm, "surround"),
    },
  );
  Vim.defineMotion("lindvimeraSurroundTarget", (cm, head, args, _vim, input) => {
    const range = findSurround(
      cm.getValue(),
      cm.indexFromPos(head),
      args.selectedCharacter ?? "",
      ((input.operatorArgs as SurroundArgs | undefined)?.count ?? 1) * args.repeat,
    );
    if (input.operatorArgs) (input.operatorArgs as SurroundArgs).range = range;
    return range ? [cm.posFromIndex(range.outer.from), cm.posFromIndex(range.outer.to)] : undefined;
  });
  Vim.mapCommand(
    "<character>",
    "motion",
    "lindvimeraSurroundTarget",
    {},
    {
      context: "operatorPending",
      when: (cm: CodeMirrorV) =>
        /^lindvimeraSurround(?:Delete|Change)$/.test(cm.state.vim.inputState.operator ?? ""),
    },
  );
  Vim.defineAction("lindvimeraSurroundFinish", (cm, actionArgs) => {
    const state = pending.get(cm);
    pending.delete(cm);
    cm.state.vim.expectLiteralNext = false;
    if (!state || !actionArgs.selectedCharacter || state.document !== cm.getValue()) return;
    // This is the same args object retained by lastEditInputState, making dot replay
    // recompute the motion with this delimiter through the ordinary operator dispatcher.
    state.args.replacement = actionArgs.selectedCharacter;
    const head =
      state.operation === "add"
        ? applyAdd(cm, state.args, state.ranges)
        : applyChange(cm, state.args, state.ranges);
    if (head) cm.setCursor(head);
  });
  Vim.defineAction("lindvimeraSurroundCancel", (cm) => {
    pending.delete(cm);
    cm.state.vim.expectLiteralNext = false;
  });
  Vim.mapCommand(
    "<character>",
    "action",
    "lindvimeraSurroundFinish",
    {},
    {
      context: "normal",
      when: (cm: CodeMirrorV) => pending.has(cm),
    },
  );
  for (const key of ["<Esc>", "<C-c>", "<C-[>"]) {
    Vim.mapCommand(
      key,
      "action",
      "lindvimeraSurroundCancel",
      {},
      {
        context: "normal",
        when: (cm: CodeMirrorV) => pending.has(cm),
      },
    );
  }
}
