import {
  foldable,
  foldEffect,
  unfoldEffect,
  forceParsing,
  syntaxTreeAvailable,
  language,
} from "@codemirror/language";
import { Transaction } from "@codemirror/state";
import { runScopeHandlers } from "@codemirror/view";
import { currentFolds, sourceFold } from "../../folding/host";
import { planFolds, type FoldCommand } from "../../folding/ranges";
import { indexMarkdown, markdownObject, structureMotion } from "../../markdown/ranges";
import { markdownBlockObject } from "../../markdown/blocks";
import { internalLinkAt } from "../../markdown/links";
import { resolveNativeTable } from "../../table/native-adapter";
import type { NativeCommandQueue } from "./ex-mapping";
import {
  buildMarkdownEditingIndex,
  markdownContentStart,
  markdownOpenLine,
} from "../../markdown/editing";
import { findSurround, surroundText } from "../../markdown/surround";
import { createWordProvider, WordBoundaryCache } from "../../word";
import { createSentenceProvider } from "../../word/sentence";
import type { BackendHost } from "../types";
import type {
  NativeArgs,
  NativeCM,
  NativeCommand,
  NativeInput,
  NativeRange,
  NativeVim,
  Position,
} from "./native";

const prefix = "lindvimera115_";
const sessions = new WeakMap<NativeCM, NativeExtensions>();
const installed = new WeakSet<NativeVim>();
const graphemes = new Intl.Segmenter("ja", { granularity: "grapheme" });

function lastCharacter(text: string, from: number, to: number): number {
  let last = from;
  for (const segment of graphemes.segment(text.slice(from, to))) last = from + segment.index;
  return last;
}

interface SurroundPending {
  ranges: NativeRange[];
  args: NativeArgs;
  operation: "add" | "change";
  document: string;
  previousEdit?: NativeInput;
  previousAction?: unknown;
}

/** Native registration has no deletion API. These stable, namespaced callbacks
 * retain only this weak registry, never a host, view, or plugin instance. */
export function installDefinitions(vim: NativeVim): void {
  if (installed.has(vim)) return;
  for (const name of [
    "word",
    "wordObject",
    "sentence",
    "sentenceObject",
    "character",
    "structure",
    "markdownObject",
    "surroundTarget",
    "contentStart",
    "contentVertical",
  ] as const) {
    vim.defineMotion(prefix + name, (cm, head, args, state, input) =>
      sessions.get(cm)?.motion(name, head, args, state.visualMode === true, input),
    );
  }
  for (const name of ["surroundAdd", "surroundDelete", "surroundChange"] as const) {
    vim.defineOperator(prefix + name, (cm, args, ranges) =>
      sessions.get(cm)?.operator(name, args, ranges),
    );
  }
  for (const name of [
    "surroundFinish",
    "surroundCancel",
    "fold",
    "openLink",
    "insertContent",
    "openAbove",
    "openBelow",
    "tableLeave",
    "tableMove",
  ] as const) {
    vim.defineAction(prefix + name, (cm, args) => sessions.get(cm)?.action(name, args));
  }
  installed.add(vim);
}

export class NativeExtensions {
  private cache: WordBoundaryCache;
  private words: ReturnType<typeof createWordProvider>;
  private sentences: ReturnType<typeof createSentenceProvider>;
  private pending?: SurroundPending;
  private beforeSurround?: NativeInput;
  private beforeSurroundAction?: unknown;
  private nativeOpenAbove = false;
  private disposed = false;
  private foldGeneration = 0;
  private verticalGoal?: number;
  private verticalPosition?: Position;
  private revision?: object;
  private editingIndex?: ReturnType<typeof buildMarkdownEditingIndex>;
  private markdownIndex?: ReturnType<typeof indexMarkdown>;
  private originalSelections?: NativeCM["setSelections"];
  private ownedSelections?: NativeCM["setSelections"];

  private invalidateIndexes(): void {
    const revision = this.cm.cm6.state.doc;
    if (revision !== this.revision) {
      this.revision = revision;
      this.editingIndex = undefined;
      this.markdownIndex = undefined;
    }
  }

  private editing(): ReturnType<typeof buildMarkdownEditingIndex> {
    this.invalidateIndexes();
    return (this.editingIndex ??= buildMarkdownEditingIndex(this.cm.getValue()));
  }

  private markdown(): ReturnType<typeof indexMarkdown> {
    this.invalidateIndexes();
    return (this.markdownIndex ??= indexMarkdown(this.cm.getValue()));
  }

  constructor(
    readonly cm: NativeCM,
    private vim: NativeVim,
    private host: BackendHost,
    private queue?: NativeCommandQueue,
    private beginInsertGroup?: () => void,
  ) {
    this.cache = new WordBoundaryCache(
      512,
      262_144,
      host.settings().japanese,
      host.wordSegmenter(),
    );
    this.words = createWordProvider(this.cache);
    this.sentences = createSentenceProvider(this.cache);
    sessions.set(cm, this);
    const previous = cm.setSelections;
    if (previous) {
      this.originalSelections = previous;
      this.ownedSelections = function (this: NativeCM, ranges, primary) {
        const session = sessions.get(this);
        return previous.call(this, session?.normalizeSelections(ranges) ?? ranges, primary);
      };
      cm.setSelections = this.ownedSelections;
    }
  }

  normalizeSelections(ranges: NativeRange[]): NativeRange[] {
    if (!this.active()) return ranges;
    const snap = (position: Position, end: boolean): Position => {
      if (position.line < this.cm.firstLine() || position.line > this.cm.lastLine())
        return position;
      const text = this.cm.getLine(position.line);
      if (position.ch < 0 || position.ch > text.length) return position;
      const boundaries = this.cache.graphemes(text);
      if (boundaries.includes(position.ch)) return position;
      const next = boundaries.findIndex((boundary) => boundary > position.ch);
      return { ...position, ch: boundaries[end ? next : Math.max(0, next - 1)] };
    };
    for (const range of ranges) {
      const forward =
        range.anchor.line < range.head.line ||
        (range.anchor.line === range.head.line && range.anchor.ch < range.head.ch);
      if (range.anchor.line === range.head.line && range.anchor.ch === range.head.ch) continue;
      // Native operator dispatch passes this same mutable range array to the
      // operator after setSelections; update it as well as the visible selection.
      range.anchor = snap(range.anchor, !forward);
      range.head = snap(range.head, forward);
    }
    return ranges;
  }

  active(): boolean {
    return (
      !this.disposed &&
      this.host.isActive() &&
      (this.host.settings().tables || !this.cm.cm6.dom.closest(".cm-table-widget"))
    );
  }

  configure(): void {
    const settings = this.host.settings();
    if (
      this.cache.useJapanese !== settings.japanese ||
      this.cache.japaneseSegmenter !== this.host.wordSegmenter()
    ) {
      this.cache.clear();
      this.cache = new WordBoundaryCache(
        512,
        262_144,
        settings.japanese,
        this.host.wordSegmenter(),
      );
      this.words = createWordProvider(this.cache);
      this.sentences = createSentenceProvider(this.cache);
    }
    if (!this.active() || !settings.surround) this.cancel();
  }

  commands(key?: string): NativeCommand[] {
    if (!this.active()) return [];
    const settings = this.host.settings();
    const state = this.cm.state.vim!;
    const input = state.inputState;
    const commands: NativeCommand[] = [];
    const motion = (keys: string, name: string, args: Partial<NativeArgs> = {}, context?: string) =>
      commands.push({ keys, type: "motion", motion: prefix + name, motionArgs: args, context });
    const action = (
      keys: string,
      name: string,
      args: Partial<NativeArgs> = {},
      context = "normal",
    ) => commands.push({ keys, type: "action", action: prefix + name, actionArgs: args, context });
    // The host still owns mode transitions, native operators and their replay state.
    for (const [keys, forward, wordEnd] of [
      ["w", true, false],
      ["b", false, false],
      ["e", true, true],
      ["ge", false, true],
    ] as const)
      motion(keys, "word", { forward, wordEnd, inclusive: wordEnd });
    for (const [keys, forward] of [
      ["h", false],
      ["l", true],
      ["<Left>", false],
      ["<Right>", true],
    ] as const)
      motion(keys, "character", { forward });
    for (const forward of [false, true]) motion(forward ? ")" : "(", "sentence", { forward });
    if (key === "*" || key === "#") {
      const range = this.words.expand(this.cm, this.cm.getCursor(), { innerWord: true, repeat: 1 });
      if (range) {
        const text = this.cm
          .getValue()
          .slice(this.cm.indexFromPos(range.start), this.cm.indexFromPos(range.end));
        if (text && !/\s/u.test(text)) {
          const literal = text.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
          for (const whole of [false, true]) {
            const pattern =
              whole && /^[\p{ASCII}]+$/u.test(text) && /^\w+$/u.test(text)
                ? `\\b${literal}\\b`
                : literal;
            commands.push({
              keys: `${whole ? "" : "g"}${key}`,
              type: "keyToKey",
              toKeys: `${key === "*" ? "/" : "?"}${pattern.replace(/</gu, "<lt>")}<CR>`,
              noremap: false,
            });
          }
        }
      }
    }
    for (const inner of [true, false])
      for (const context of ["operatorPending", "visual"]) {
        for (const bigWord of [false, true])
          motion(
            `${inner ? "i" : "a"}${bigWord ? "W" : "w"}`,
            "wordObject",
            { textObjectInner: inner, bigWord },
            context,
          );
        motion(`${inner ? "i" : "a"}s`, "sentenceObject", { textObjectInner: inner }, context);
      }
    if (settings.markdownMotions)
      for (const kind of ["heading", "list"] as const)
        for (const forward of [false, true])
          motion(`${forward ? "]" : "["}${kind === "heading" ? "h" : "l"}`, "structure", {
            kind,
            forward,
            toJumplist: true,
          });
    if (settings.textObjects)
      for (const kind of ["*", "_", "`", "l", "C", "h", "L"] as const)
        for (const inner of [true, false])
          for (const context of ["operatorPending", "visual"])
            motion(
              `${inner ? "i" : "a"}${kind}`,
              "markdownObject",
              { kind, textObjectInner: inner },
              context,
            );
    const body = !this.cm.cm6.dom.closest(".cm-table-widget");
    // Smart Lists is a host setting and remains effective independently of our
    // optional content-start/open-above Markdown extensions.
    if (body && this.vim.enterInsertMode)
      commands.push({
        keys: "o",
        type: "action",
        action: prefix + "openBelow",
        context: "normal",
        isEdit: true,
        interlaceInsertRepeat: true,
      });
    if (!body && settings.tables)
      for (const context of ["normal", "visual"]) {
        action("[t", "tableLeave", { forward: false }, context);
        action("]t", "tableLeave", { forward: true }, context);
        action("<Tab>", "tableMove", { forward: true }, context);
        action("<S-Tab>", "tableMove", { forward: false }, context);
      }
    if (
      body &&
      this.cm.findPosV &&
      this.cm.cm6.dom.closest(".markdown-source-view")?.classList.contains("is-live-preview")
    )
      for (const forward of [false, true])
        for (const context of ["normal", "visual"])
          motion(forward ? "j" : "k", "contentVertical", { forward, linewise: true }, context);
    if (settings.markdownEditing && body) {
      motion("^", "contentStart");
      if (this.vim.enterInsertMode) {
        commands.push({
          keys: "I",
          type: "action",
          action: prefix + "insertContent",
          context: "normal",
          isEdit: true,
        });
        // Native O owns non-Markdown/frontmatter behavior; our callback only
        // handles rows for which the pure Markdown planner has an actual edit.
        if (
          key === "O" &&
          !this.nativeOpenAbove &&
          markdownOpenLine(this.editing(), this.cm.indexFromPos(this.cm.getCursor()), false, false)
        )
          commands.push({
            keys: "O",
            type: "action",
            action: prefix + "openAbove",
            context: "normal",
            isEdit: true,
            interlaceInsertRepeat: true,
          });
      }
    }
    if (settings.folding)
      for (const command of ["za", "zo", "zc", "zA", "zO", "zC", "zM", "zR"])
        for (const context of [
          "normal",
          ...(["zo", "zc", "zO", "zC"].includes(command) ? ["visual"] : []),
        ])
          action(command, "fold", { command }, context);
    action("gf", "openLink");
    if (settings.surround) {
      const operation = { yank: "surroundAdd", delete: "surroundDelete", change: "surroundChange" }[
        input.operator ?? ""
      ];
      if (operation)
        commands.push({
          keys: "s",
          type: "operator",
          operator: prefix + operation,
          context: "operatorPending",
        });
      if (input.operator === prefix + "surroundAdd")
        commands.push({
          keys: "s",
          type: "operator",
          operator: input.operator,
          context: "operatorPending",
        });
      if (
        input.operator === prefix + "surroundDelete" ||
        input.operator === prefix + "surroundChange"
      )
        motion("<character>", "surroundTarget", {}, "operatorPending");
      commands.push({
        keys: "gS",
        type: "operator",
        operator: prefix + "surroundAdd",
        context: "visual",
      });
      if (this.pending) {
        action("<character>", "surroundFinish");
        for (const key of ["<Esc>", "<C-c>", "<C-[>"]) action(key, "surroundCancel");
      }
    }
    return commands;
  }

  /** Keep the native InputState/count/register object while changing y/d/c+s
   * into an owned operator. No editing is dispatched outside native Vim. */
  beforeCommand(key: string): void {
    const state = this.cm.state.vim;
    if (!state || !this.active() || !this.host.settings().surround) return;
    if (key === "s" && ["yank", "delete", "change"].includes(state.inputState.operator ?? "")) {
      this.beforeSurround = state.lastEditInputState;
      this.beforeSurroundAction = state.lastEditActionCommand;
      state.inputState.operator = undefined;
    }
    if (key === "S" && state.visualMode) {
      this.beforeSurround = state.lastEditInputState;
      this.beforeSurroundAction = state.lastEditActionCommand;
    }
  }

  afterCommand(): void {
    const state = this.cm.state.vim;
    if (this.pending && state) state.expectLiteralNext = true;
    // Native CM6 reflects exclusive selections back into inclusive Vim heads
    // by subtracting one UTF-16 unit. Correct that metadata after the native
    // operation so a combining mark is not treated as a second selected word.
    if (state?.visualMode && !state.visualLine) {
      state.sel.anchor = this.words.character(this.cm, state.sel.anchor, 0);
      state.sel.head = this.words.character(this.cm, state.sel.head, 0);
    }
  }

  motion(
    name: string,
    head: Position,
    args: NativeArgs,
    visual: boolean,
    input: NativeInput,
  ): Position | [Position, Position] | undefined | null {
    if (!this.active()) return;
    const cm = this.cm;
    if (name === "character") {
      let target = head;
      for (let count = 0; count < args.repeat; count++)
        target = this.words.character(cm, target, args.forward ? 1 : -1);
      return target;
    }
    if (name === "word") {
      const changeWord =
        input.operator === "change" &&
        args.forward &&
        !args.wordEnd &&
        /\S/u.test(cm.getLine(head.line).slice(head.ch, head.ch + 1));
      const target = this.words.move(cm, head, {
        repeat: args.repeat,
        forward: args.forward,
        wordEnd: changeWord || args.wordEnd,
      });
      if (input.operator && (args.wordEnd || changeWord)) {
        args.inclusive = false;
        return this.words.character(cm, target, 1);
      }
      return target;
    }
    if (name === "sentence") return this.sentences.move(cm, head, args);
    if (name === "wordObject" || name === "sentenceObject") {
      const selection = cm.state.vim!.sel;
      const options = {
        repeat: args.repeat,
        inclusive: !args.textObjectInner,
        innerWord: args.textObjectInner,
        bigWord: args.bigWord,
        ...(visual
          ? {
              visualSelection: {
                anchor: this.words.character(cm, selection.anchor, 0),
                head: this.words.character(cm, selection.head, 0),
              },
            }
          : {}),
      };
      const range =
        name === "wordObject"
          ? this.words.expand(cm, head, options)
          : this.sentences.expand(cm, head, options);
      if (!range) return;
      const end =
        visual && range.end.ch === 0 && range.end.line > cm.firstLine()
          ? { line: range.end.line - 1, ch: cm.getLine(range.end.line - 1).length }
          : visual
            ? this.words.character(cm, range.end, -1)
            : range.end;
      return [range.start, end];
    }
    const text = cm.getValue();
    const offset = cm.indexFromPos(head);
    if (name === "contentStart") {
      const content = markdownContentStart(this.editing(), offset);
      if (content !== undefined) {
        const position = cm.posFromIndex(content);
        return position.ch === cm.getLine(position.line).length ? undefined : position;
      }
      return { line: head.line, ch: Math.max(0, cm.getLine(head.line).search(/\S/u)) };
    }
    if (name === "contentVertical") {
      const index = this.editing();
      const contentOffset = (position: Position) => {
        const lineStart = cm.indexFromPos({ line: position.line, ch: 0 });
        return (markdownContentStart(index, cm.indexFromPos(position)) ?? lineStart) - lineStart;
      };
      if (
        this.verticalGoal === undefined ||
        this.verticalPosition?.line !== head.line ||
        this.verticalPosition?.ch !== head.ch
      )
        this.verticalGoal = Math.max(0, head.ch - contentOffset(head));
      const amount = (args.forward ? 1 : -1) * args.repeat;
      const visible = cm.findPosV!(head, amount, "line", cm.state.vim!.lastHSPos);
      if (visible.focusBefore) {
        visible.focusBefore();
        return head;
      }
      if (visible.hitSide && visible.line === head.line && visible.ch === head.ch) return head;
      const physical = Math.max(cm.firstLine(), Math.min(cm.lastLine(), head.line + amount));
      const line = args.forward
        ? Math.max(physical, visible.line)
        : Math.min(physical, visible.line);
      const ch = Math.min(
        Math.max(0, cm.getLine(line).length - 1),
        contentOffset({ line, ch: 0 }) + this.verticalGoal,
      );
      const position = { line, ch };
      this.verticalPosition = position;
      cm.state.vim!.lastHPos = ch;
      cm.state.vim!.lastHSPos = cm.charCoords?.(position, "div").left;
      return position;
    }
    if (name === "surroundTarget") {
      const range = findSurround(text, offset, args.selectedCharacter ?? "", args.repeat);
      return range
        ? [cm.posFromIndex(range.outer.from), cm.posFromIndex(range.outer.to)]
        : undefined;
    }
    const index = this.markdown();
    if (name === "structure") {
      const target = structureMotion(
        index,
        text,
        offset,
        args.kind as "heading" | "list",
        !!args.forward,
        args.repeat,
      );
      return target === undefined ? undefined : cm.posFromIndex(target);
    }
    if (name === "markdownObject") {
      const kind = args.kind as "*" | "_" | "`" | "l" | "C" | "h" | "L";
      if ((kind === "h" || kind === "L") && cm.cm6.dom.closest(".cm-table-widget")) return;
      const range =
        kind === "h" || kind === "L"
          ? markdownBlockObject(
              index,
              text.length,
              offset,
              kind,
              !!args.textObjectInner,
              args.repeat,
            )
          : markdownObject(index, offset, kind, !!args.textObjectInner, args.repeat);
      if (!range) return;
      const linewise = "linewise" in range && range.linewise === true;
      args.linewise = linewise;
      if (visual && linewise) {
        cm.state.vim!.visualLine = true;
        cm.state.vim!.visualBlock = false;
      }
      const end =
        (visual || linewise) && range.to > range.from
          ? lastCharacter(text, range.from, range.to)
          : range.to;
      return [cm.posFromIndex(range.from), cm.posFromIndex(end)];
    }
  }

  operator(name: string, args: NativeArgs, ranges: NativeRange[]): Position | undefined {
    if (!this.active()) return;
    if (name !== "surroundDelete" && !args.replacement) {
      this.pending = {
        args,
        ranges: ranges.map((range) => ({ anchor: { ...range.anchor }, head: { ...range.head } })),
        operation: name === "surroundAdd" ? "add" : "change",
        document: this.cm.getValue(),
        previousEdit: this.beforeSurround,
        previousAction: this.beforeSurroundAction,
      };
      return ranges[0]?.anchor;
    }
    return this.applySurround(name === "surroundAdd" ? "add" : "change", args, ranges);
  }

  private applySurround(
    operation: "add" | "change",
    args: NativeArgs,
    ranges: NativeRange[],
  ): Position | undefined {
    const cm = this.cm;
    let cursor: Position | undefined;
    for (const range of [...ranges].reverse()) {
      let from = Math.min(cm.indexFromPos(range.anchor), cm.indexFromPos(range.head));
      let to = Math.max(cm.indexFromPos(range.anchor), cm.indexFromPos(range.head));
      const text = cm.getValue();
      if (operation === "change") {
        const found = findSurround(text, from, args.selectedCharacter ?? "", 1);
        if (!found) continue;
        const content = text.slice(found.inner.from, found.inner.to);
        cursor = cm.posFromIndex(found.outer.from);
        cm.replaceRange(
          args.replacement ? surroundText(content, args.replacement) : content,
          cursor,
          cm.posFromIndex(found.outer.to),
        );
      } else {
        let content = text.slice(from, to);
        if (args.linewise) {
          from += /^\s*/u.exec(content)![0].length;
          to = Math.max(from, to - /\s*$/u.exec(content)![0].length);
          content = text.slice(from, to);
        }
        cursor = cm.posFromIndex(from);
        cm.replaceRange(surroundText(content, args.replacement ?? ""), cursor, cm.posFromIndex(to));
      }
    }
    return cursor;
  }

  action(name: string, args: NativeArgs): void {
    if (!this.active()) return;
    if (name === "tableLeave" || name === "tableMove") {
      let owner: unknown;
      this.host.app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view as unknown as {
          editMode?: { cm?: unknown; tableCell?: { cm?: unknown } };
        };
        if (view.editMode?.tableCell?.cm === this.cm.cm6) owner = view.editMode;
      });
      const table = resolveNativeTable(owner, this.cm.cm6);
      if (!table.supported) return;
      const generation = ++this.foldGeneration;
      const task = Promise.resolve()
        .then(() => {
          if (!this.active() || generation !== this.foldGeneration) return;
          const context = table.context;
          if (name === "tableLeave") context.leave(args.forward ? "after" : "before");
          else {
            const current = context.currentCell;
            if (!current) return;
            const model = context.snapshot();
            const columns = model.rows[0].length;
            const index = Math.max(
              0,
              Math.min(
                model.rows.length * columns - 1,
                current.row * columns +
                  current.column +
                  (args.forward ? 1 : -1) * Math.max(1, args.repeat),
              ),
            );
            context.focus({ row: Math.floor(index / columns), column: index % columns, offset: 0 });
          }
        })
        .catch((error) => {
          if (this.active()) this.host.reportError(String(error));
        });
      this.queue?.waitFor(task, () => {
        this.foldGeneration++;
      });
      return;
    }
    if (name === "insertContent" || name === "openAbove" || name === "openBelow") {
      if (name !== "insertContent") this.beginInsertGroup?.();
      const cm = this.cm;
      const index = this.editing();
      const at = cm.indexFromPos(cm.getCursor());
      if (name === "insertContent") {
        const content = markdownContentStart(index, at);
        const head = cm.getCursor();
        cm.setCursor(
          content === undefined
            ? { line: head.line, ch: Math.max(0, cm.getLine(head.line).search(/\S/u)) }
            : cm.posFromIndex(content),
        );
      } else if (name === "openBelow") {
        const head = cm.getCursor();
        cm.setCursor({ line: head.line, ch: cm.getLine(head.line).length });
        const owner = cm.cm6.dom.ownerDocument.defaultView!;
        if (
          !runScopeHandlers(
            cm.cm6,
            new owner.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
            "editor",
          )
        ) {
          this.host.reportError("Obsidian の改行コマンドを実行できませんでした。");
          return;
        }
      } else {
        const edit = markdownOpenLine(index, at, false, false);
        if (!edit) {
          const state = cm.state.vim!;
          const previousEdit = state.lastEditInputState;
          const previousAction = state.lastEditActionCommand;
          this.nativeOpenAbove = true;
          try {
            if (args.repeat > 1)
              for (const digit of String(args.repeat)) this.vim.handleKey(cm, digit, "mapping");
            this.vim.handleKey(cm, "O", "mapping");
          } finally {
            this.nativeOpenAbove = false;
            state.lastEditInputState = previousEdit;
            state.lastEditActionCommand = previousAction;
          }
          return;
        }
        for (const change of [...edit.changes].sort((a, b) => b.from - a.from))
          cm.replaceRange(change.insert, cm.posFromIndex(change.from), cm.posFromIndex(change.to));
        cm.setCursor(cm.posFromIndex(edit.cursor));
      }
      this.vim.enterInsertMode?.(cm);
      if (cm.state.vim) cm.state.vim.insertModeRepeat = args.repeat;
      return;
    }
    if (name === "surroundCancel") {
      this.cancel();
      return;
    }
    if (name === "surroundFinish") {
      const pending = this.pending;
      this.pending = undefined;
      if (this.cm.state.vim) this.cm.state.vim.expectLiteralNext = false;
      if (!pending || !args.selectedCharacter || pending.document !== this.cm.getValue()) return;
      pending.args.replacement = args.selectedCharacter;
      const cursor = this.applySurround(pending.operation, pending.args, pending.ranges);
      if (cursor) this.cm.setCursor(cursor);
    } else if (name === "fold") this.fold(args.command as FoldCommand, args.repeat);
    else if (name === "openLink") {
      const link = internalLinkAt(this.cm.getValue(), this.cm.indexFromPos(this.cm.getCursor()));
      if (link !== undefined)
        void this.host.app.workspace.openLinkText(
          link,
          this.host.app.workspace.getActiveFile()?.path ?? "",
        );
    }
  }

  private fold(command: FoldCommand, count: number): void {
    const cm = this.cm;
    const view = cm.cm6;
    if (view.dom.closest(".cm-table-widget")) return;
    const doc = view.state.doc;
    const generation = ++this.foldGeneration;
    const state = cm.state.vim!;
    const visual = state.visualMode;
    const anchor = cm.indexFromPos(visual ? state.sel.anchor : cm.getCursor());
    const head = cm.indexFromPos(visual ? state.sel.head : cm.getCursor());
    const valid = () =>
      this.active() && generation === this.foldGeneration && view.state.doc === doc;
    try {
      // Native macro playback is synchronous and exposes no suspend/resume API.
      // Resolve the fold before returning so the next macro motion sees it.
      if (view.state.facet(language) && !syntaxTreeAvailable(view.state, doc.length)) {
        forceParsing(view, doc.length, 100);
        if (!syntaxTreeAvailable(view.state, doc.length))
          throw new Error(
            "文書の解析が完了しなかったため、折り畳みを変更しませんでした。解析後に再実行してください。",
          );
      }
      if (!valid()) return;
      const candidates = [];
      for (let number = 1; number <= doc.lines; number++) {
        const line = doc.line(number);
        const range = foldable(view.state, line.from, line.to);
        if (range) candidates.push(sourceFold(view.state, range.from, range.to));
      }
      const plan = planFolds(candidates, currentFolds(view.state), {
        command,
        count,
        line: doc.lineAt(head).number,
        ...(visual
          ? {
              selection: {
                firstLine: doc.lineAt(Math.min(anchor, head)).number,
                lastLine: doc.lineAt(Math.max(anchor, head)).number,
              },
            }
          : {}),
      });
      cm.operation(() => {
        if (visual) this.vim.exitVisualMode(cm, false);
        view.dispatch({
          effects: [
            ...plan.open.map((range) => unfoldEffect.of(range)),
            ...plan.close.map((range) => foldEffect.of(range)),
          ],
          annotations: Transaction.addToHistory.of(false),
        });
      });
    } catch (error) {
      if (valid()) this.host.reportError(String(error));
    }
  }

  settled(): Promise<void> {
    return Promise.resolve();
  }

  cancel(): void {
    if (this.pending && this.cm.state.vim) {
      this.cm.state.vim.lastEditInputState = this.pending.previousEdit;
      this.cm.state.vim.lastEditActionCommand = this.pending.previousAction;
      this.cm.state.vim.expectLiteralNext = false;
    }
    this.pending = undefined;
    this.foldGeneration++;
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
    this.cache.clear();
    if (this.cm.setSelections === this.ownedSelections)
      this.cm.setSelections = this.originalSelections;
    sessions.delete(this.cm);
  }
}
