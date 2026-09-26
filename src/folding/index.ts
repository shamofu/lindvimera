import {
  codeFolding,
  foldEffect,
  foldState,
  foldable,
  forceParsing,
  language,
  syntaxTreeAvailable,
  unfoldEffect,
} from "@codemirror/language";
import { StateEffect, Transaction } from "@codemirror/state";
import { Vim, type CodeMirror } from "@replit/codemirror-vim";
import type { CodeMirrorV } from "@replit/codemirror-vim-core";
import { currentFolds, sourceFold } from "./host";
import { foldKey, planFolds, type FoldCommand, type FoldRange, type FoldRequest } from "./ranges";

export { revealFoldedRange } from "./host";

export interface FoldingOptions {
  enabled(): boolean;
  documentIdentity(): unknown;
  waitFor(task: Promise<void>, cancel: () => void): void;
  afterCommand?(): void;
}

const sessions = new WeakMap<object, FoldingSession>();
let installed = false;

export function installFoldingCommands(): void {
  if (installed) return;
  installed = true;
  for (const command of ["za", "zo", "zc", "zA", "zO", "zC", "zM", "zR"] as const) {
    const name = `lindvimeraFold${command}`;
    Vim.defineAction(name, (cm, args) => sessions.get(cm)?.execute(command, args.repeat));
    const contexts = ["normal", ...(["zo", "zc", "zO", "zC"].includes(command) ? ["visual"] : [])];
    for (const context of contexts)
      Vim.mapCommand(
        command,
        "action",
        name,
        {},
        {
          context,
          when: (cm: object) => sessions.get(cm)?.enabled() === true,
        },
      );
  }
}

export function configureFolding(cm: CodeMirror, options: FoldingOptions): void {
  clearFolding(cm);
  sessions.set(cm, new FoldingSession(cm, options));
  installFoldingCommands();
}

export function clearFolding(cm: object): void {
  sessions.get(cm)?.destroy();
  sessions.delete(cm);
}

class FoldingSession {
  private generation = 0;
  private disposed = false;

  constructor(
    private cm: CodeMirror,
    private options: FoldingOptions,
  ) {}

  enabled(): boolean {
    return !this.disposed && this.options.enabled();
  }

  execute(command: FoldCommand, count: number): void {
    const cm = this.cm;
    const view = cm.cm6;
    // A cell has its own coordinates. Folding must never act on its parent implicitly.
    if (!this.enabled() || cm.getEditingView() !== view) return;
    const doc = view.state.doc;
    const identity = this.options.documentIdentity();
    const generation = ++this.generation;
    const vim = cm.state.vim!;
    const visual = !!vim.visualMode;
    const cursor = view.state.selection.main.head;
    const anchor = visual ? cm.indexFromPos(vim.sel.anchor) : cursor;
    const head = visual ? cm.indexFromPos(vim.sel.head) : cursor;
    const position = visual ? Math.min(anchor, head) : cursor;
    const request: FoldRequest = {
      command,
      line: doc.lineAt(cursor).number,
      count,
      ...(visual
        ? {
            selection: {
              firstLine: doc.lineAt(Math.min(anchor, head)).number,
              lastLine: doc.lineAt(Math.max(anchor, head)).number,
            },
          }
        : {}),
    };
    const valid = () =>
      !this.disposed &&
      this.enabled() &&
      generation === this.generation &&
      this.options.documentIdentity() === identity &&
      view.state.doc === doc &&
      cm.getEditingView() === view;
    const check = () => {
      if (!valid()) throw new Error("折り畳み操作は取り消されました。");
    };
    const task = Promise.resolve().then(async () => {
      check();
      const candidates: FoldRange[] = [];
      // Opening is fully described by existing folds. Closing requires parsed host ranges.
      const needsCandidates =
        !["zo", "zO", "zR"].includes(command) &&
        !(
          (command === "za" || command === "zA") &&
          currentFolds(view.state).some(
            (fold) => fold.firstLine <= request.line && request.line <= fold.lastLine,
          )
        );
      if (needsCandidates) {
        const deadline = Date.now() + 2000;
        while (view.state.facet(language) && !syntaxTreeAvailable(view.state, doc.length)) {
          check();
          if (Date.now() >= deadline)
            throw new Error("文書の解析が完了しなかったため、折り畳みを変更しませんでした。");
          forceParsing(view, doc.length, 25);
          await new Promise<void>((resolve) =>
            view.dom.ownerDocument.defaultView!.setTimeout(resolve, 0),
          );
        }
        for (let number = 1; number <= doc.lines; number++) {
          const line = doc.line(number);
          const range = foldable(view.state, line.from, line.to);
          if (range && range.from >= 0 && range.from < range.to && range.to <= doc.length)
            candidates.push(sourceFold(view.state, range.from, range.to));
          if (number % 256 === 0) {
            await new Promise<void>((resolve) =>
              view.dom.ownerDocument.defaultView!.setTimeout(resolve, 0),
            );
            check();
          }
        }
      }
      check();
      const before = currentFolds(view.state);
      const result = planFolds(candidates, before, request);
      const effects: StateEffect<unknown>[] = [
        ...result.open.map((fold) => unfoldEffect.of({ from: fold.from, to: fold.to })),
        ...result.close.map((fold) => foldEffect.of({ from: fold.from, to: fold.to })),
      ];
      if (result.close.length && !view.state.field(foldState, false))
        effects.push(StateEffect.appendConfig.of(codeFolding()));
      const removed = new Set(result.open.map(foldKey));
      const remaining = [...before.filter((fold) => !removed.has(foldKey(fold))), ...result.close];
      const covering = remaining
        .filter((fold) => fold.from < position && position < fold.to)
        .sort((a, b) => a.from - b.from || b.to - a.to)[0];
      const target = covering ? doc.lineAt(covering.from).from : position;
      cm.operation(() => {
        if (visual) Vim.exitVisualMode(cm as CodeMirrorV, false);
        if (effects.length || visual || target !== cursor)
          view.dispatch({
            effects,
            selection: { anchor: target },
            annotations: Transaction.addToHistory.of(false),
          });
      });
      this.options.afterCommand?.();
    });
    this.options.waitFor(task, () => {
      if (generation === this.generation) this.generation++;
    });
  }

  destroy(): void {
    this.disposed = true;
    this.generation++;
  }
}
