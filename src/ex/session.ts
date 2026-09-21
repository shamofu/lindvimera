import { Vim, type CodeMirror } from "@replit/codemirror-vim";
import type {
  ExCommandContext,
  ExCommandProvider,
  ParsedExCommand,
  Pos,
} from "@replit/codemirror-vim-core";
import type { PendingCommands } from "../runtime/pending";
import type { VimHistoryGroup } from "../runtime/history";
import {
  expandReplacement,
  parseEx,
  unescapePattern,
  unescapeReplacement,
  type ExAddress,
  type ExSyntax,
} from "./parser";

interface Substitution {
  query: RegExp;
  replacement: string;
  allMatches: boolean;
  confirm: boolean;
}
interface ResolvedEx extends ParsedExCommand {
  syntax: ExSyntax;
  from: number;
  to: number;
  substitution?: Substitution;
  replacements?: Replacement[];
}
interface Replacement {
  from: number;
  to: number;
  text: string;
}

export interface ExSessionOptions {
  history: VimHistoryGroup;
  pending: PendingCommands;
  error(message: string): void;
  documentIdentity?(): unknown;
}

/** Supported Ex editing operates exclusively on the active body or decoded cell. */
export class ExSession {
  private readonly previous: ExCommandProvider | undefined;
  private lastSubstitution?: Substitution;
  private confirmation?: { finish(abort?: boolean): void };
  private clipboard?: { cancel(): void };
  private disposed = false;
  private readonly provider: ExCommandProvider = {
    parse: (input, context) => this.parse(input, context),
    execute: (command, context) => this.execute(command as ResolvedEx, context),
    onError: (error) => this.options.error(error instanceof Error ? error.message : String(error)),
  };

  constructor(
    private readonly cm: CodeMirror,
    private readonly options: ExSessionOptions,
  ) {
    this.previous = cm.state.exCommandProvider;
    cm.state.exCommandProvider = this.provider;
  }

  private resolveAddress(address: ExAddress): number {
    let line: number;
    const base = address.base;
    if (typeof base === "number") line = this.cm.firstLine() + base - 1;
    else if (base === ".") line = this.cm.getCursor().line;
    else if (base === "$") line = this.cm.lastLine();
    else {
      const vim = this.cm.state.vim;
      let position: Pos | null | undefined;
      if ((base.mark === "<" || base.mark === ">") && vim?.visualMode) {
        const anchor = vim.sel.anchor;
        const head = vim.sel.head;
        const before =
          anchor.line < head.line || (anchor.line === head.line && anchor.ch < head.ch);
        position = (base.mark === "<") === before ? anchor : head;
      } else if (/^[a-z]$/u.test(base.mark) && this.cm.state.navigationProvider)
        position = this.cm.state.navigationProvider.resolveMark(base.mark);
      else position = vim?.marks[base.mark]?.find();
      if (!position) throw new Error(`現在の編集対象にマーク ${base.mark} がありません。`);
      line = position.line;
    }
    return line + address.offset;
  }

  private parse(input: string, context: ExCommandContext): ResolvedEx {
    if (this.disposed) throw new Error("エディタは既に閉じられています。");
    const syntax = parseEx(input);
    let from = this.cm.getCursor().line;
    let to = from;
    if (syntax.range === "%") {
      from = this.cm.firstLine();
      to = this.cm.lastLine();
    } else if (syntax.range) {
      from = this.resolveAddress(syntax.range.from);
      to = syntax.range.to ? this.resolveAddress(syntax.range.to) : from;
    } else if (this.cm.state.vim?.visualMode) {
      from = Math.min(this.cm.state.vim.sel.anchor.line, this.cm.state.vim.sel.head.line);
      to = Math.max(this.cm.state.vim.sel.anchor.line, this.cm.state.vim.sel.head.line);
    } else if (syntax.name === "sort") {
      from = this.cm.firstLine();
      to = this.cm.lastLine();
    }
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < this.cm.firstLine() ||
      to > this.cm.lastLine() ||
      to < from
    )
      throw new Error("範囲は現在の編集対象の先頭行から末尾行までを順に指定してください。");
    const result: ResolvedEx = { input, name: syntax.name, syntax, from, to };
    if (syntax.name === "substitute") {
      const substitution = syntax.substitution;
      if (!substitution) {
        if (!this.lastSubstitution) throw new Error("直前の置換がありません。");
        result.substitution = { ...this.lastSubstitution };
      } else {
        const previous = substitution.pattern ? undefined : context.getSearch();
        if (!substitution.pattern && !previous) throw new Error("直前の検索パターンがありません。");
        const pattern = substitution.pattern
          ? unescapePattern(substitution.pattern, substitution.delimiter)
          : previous!.source;
        const ignoreCase =
          substitution.ignoreCase ?? (previous ? previous.ignoreCase : !/[A-Z]/u.test(pattern));
        const query = new RegExp(pattern, ignoreCase ? "im" : "m");
        result.substitution = {
          query,
          allMatches: substitution.allMatches,
          confirm: substitution.confirm,
          replacement: unescapeReplacement(substitution.replacement, substitution.delimiter),
        };
      }
      result.replacements = this.replacements(result);
    }
    return result;
  }

  private range(from: number, to: number): { start: Pos; end: Pos } {
    return { start: { line: from, ch: 0 }, end: { line: to, ch: this.cm.getLine(to).length } };
  }

  private execute(command: ResolvedEx, context: ExCommandContext): void {
    const { syntax, from, to } = command;
    const cm = this.cm;
    if (syntax.name === "substitute") {
      this.lastSubstitution = { ...command.substitution! };
      context.setSearch(command.substitution!.query);
      this.substitute(command, context);
      return;
    }
    if (syntax.name === "nohlsearch") context.clearSearch();
    else if (syntax.name === "move") {
      const destination = { line: to, ch: cm.getLine(to).search(/\S/u) };
      destination.ch = Math.max(0, destination.ch);
      cm.state.navigationProvider?.recordJump(cm.getCursor(), destination);
      cm.setCursor(destination);
    } else if (syntax.name === "delete" || syntax.name === "yank") {
      const { start, end } = this.range(from, to);
      const text = cm.getRange(start, end) + "\n";
      Vim.getRegisterController().pushText(syntax.register, syntax.name, text, true, false);
      if (syntax.name === "delete") {
        let deleteStart = start;
        let deleteEnd: Pos = { line: to + 1, ch: 0 };
        if (to === cm.lastLine()) {
          deleteEnd = end;
          if (from > cm.firstLine())
            deleteStart = { line: from - 1, ch: cm.getLine(from - 1).length };
        }
        cm.replaceRange("", deleteStart, deleteEnd, "+input");
        cm.setCursor({ line: Math.min(from, cm.lastLine()), ch: 0 });
      }
    } else if (syntax.name === "put") {
      if (syntax.register === "+") {
        this.putClipboard(to, context);
        return;
      }
      this.put(to, Vim.getRegisterController().getRegister(syntax.register).toString());
    } else if (syntax.name === "join") {
      const last = from === to ? Math.min(to + 1, cm.lastLine()) : to;
      const lines = Array.from({ length: last - from + 1 }, (_, index) => cm.getLine(from + index));
      const joined = lines.reduce((text, line, index) => {
        if (!index) return line;
        const next = line.trimStart();
        return text + (next && text && !/\s$/u.test(text) ? " " : "") + next;
      }, "");
      const { start, end } = this.range(from, last);
      if (cm.getRange(start, end) !== joined) cm.replaceRange(joined, start, end, "+input");
      cm.setCursor({ line: from, ch: 0 });
    } else if (syntax.name === "sort") {
      const options = syntax.sort!;
      let lines = Array.from({ length: to - from + 1 }, (_, index) => cm.getLine(from + index));
      const key = (line: string) => (options.ignoreCase ? line.toLowerCase() : line);
      const number = (line: string) => {
        const match = /[-+]?\d+/u.exec(line);
        return match ? BigInt(match[0]) : undefined;
      };
      lines.sort((left, right) => {
        let order: number;
        if (options.numeric) {
          const a = number(left),
            b = number(right);
          order = a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
        } else {
          const a = key(left),
            b = key(right);
          order = a < b ? -1 : a > b ? 1 : 0;
        }
        return order;
      });
      if (options.reverse) lines.reverse();
      if (options.unique) {
        const seen = new Set<string>();
        lines = lines.filter((line) => {
          const text = key(line);
          if (seen.has(text)) return false;
          seen.add(text);
          return true;
        });
      }
      const { start, end } = this.range(from, to);
      const sorted = lines.join("\n");
      if (cm.getRange(start, end) !== sorted) cm.replaceRange(sorted, start, end, "+input");
      cm.setCursor(start);
    }
    context.done();
  }

  private put(line: number, text: string): void {
    if (!text) return;
    const content = text.endsWith("\n") ? text.slice(0, -1) : text;
    this.cm.replaceRange(
      "\n" + content,
      { line, ch: this.cm.getLine(line).length },
      undefined,
      "+input",
    );
    this.cm.setCursor({ line: line + 1, ch: 0 });
  }

  private putClipboard(line: number, context: ExCommandContext): void {
    const source = this.cm.getValue();
    const view = this.cm.getEditingView();
    const identity = this.options.documentIdentity?.();
    let cancelled = false;
    let completed = false;
    const done = () => {
      if (!completed) {
        completed = true;
        context.done();
      }
    };
    const task = navigator.clipboard
      .readText()
      .then((text) => {
        if (cancelled || this.disposed) return;
        if (
          this.options.documentIdentity?.() !== identity ||
          this.cm.getEditingView() !== view ||
          this.cm.getValue() !== source
        )
          throw new Error("貼り付け前に編集対象が変更されました。");
        this.cm.operation(() => this.put(line, text));
      })
      .finally(() => {
        if (this.clipboard?.cancel === cancel) this.clipboard = undefined;
        done();
      });
    const cancel = () => {
      cancelled = true;
      if (this.clipboard?.cancel === cancel) this.clipboard = undefined;
      done();
    };
    this.clipboard = { cancel };
    this.options.pending.waitFor(task, cancel);
  }

  private replacements(command: ResolvedEx): Replacement[] {
    const { query, replacement, allMatches } = command.substitution!;
    const source = this.cm.getValue();
    const { start, end } = this.range(command.from, command.to);
    const from = this.cm.indexFromPos(start),
      to = this.cm.indexFromPos(end);
    const regex = new RegExp(query.source, query.flags.replace(/[gy]/gu, "") + "g");
    regex.lastIndex = from;
    const result: Replacement[] = [];
    const lines = new Set<number>();
    const boundaries = [
      ...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(source),
    ].map((part) => part.index);
    boundaries.push(source.length);
    const boundarySet = new Set(boundaries);
    let boundaryIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source))) {
      if (match.index > to) break;
      const line = this.cm.posFromIndex(match.index).line;
      if (
        match.index + match[0].length <= to &&
        boundarySet.has(match.index) &&
        boundarySet.has(match.index + match[0].length) &&
        (allMatches || !lines.has(line))
      ) {
        const text = expandReplacement(replacement, match);
        for (let index = 0; index < text.length; index++) {
          const character = text.charCodeAt(index);
          if (character >= 0xd800 && character <= 0xdbff) {
            const next = text.charCodeAt(++index);
            if (next >= 0xdc00 && next <= 0xdfff) continue;
          } else if (character < 0xdc00 || character > 0xdfff) continue;
          throw new Error("置換文字列がUnicode文字の途中を切り離しています。");
        }
        result.push({
          from: match.index,
          to: match.index + match[0].length,
          text,
        });
        lines.add(line);
      }
      if (!match[0].length) {
        while (boundaryIndex < boundaries.length && boundaries[boundaryIndex] <= match.index)
          boundaryIndex++;
        regex.lastIndex = boundaries[boundaryIndex] ?? source.length + 1;
      }
    }
    return result;
  }

  private substitute(command: ResolvedEx, context: ExCommandContext): void {
    const replacements = command.replacements!;
    if (!replacements.length) {
      this.options.error("置換パターンに一致する箇所がありません。");
      context.done();
      return;
    }
    if (!command.substitution!.confirm) {
      for (const item of [...replacements].reverse())
        this.cm.replaceRange(
          item.text,
          this.cm.posFromIndex(item.from),
          this.cm.posFromIndex(item.to),
          "+input",
        );
      this.cm.setCursor(this.cm.posFromIndex(replacements[0].from));
      context.done();
      return;
    }
    this.confirm(replacements, context);
  }

  private confirm(replacements: Replacement[], context: ExCommandContext): void {
    const cm = this.cm;
    let index = 0,
      delta = 0;
    let expected = cm.getValue();
    const target = cm.getEditingView();
    const identity = this.options.documentIdentity?.();
    let cursor = replacements[0].from;
    let settled = false;
    let close: (() => void) | undefined;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const task = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const finish = (abort = false, error?: unknown) => {
      if (settled) return;
      settled = true;
      if (this.confirmation?.finish === finish) this.confirmation = undefined;
      close?.();
      if (!abort && !this.disposed) {
        cm.setCursor(cm.posFromIndex(Math.max(0, Math.min(cursor, cm.getValue().length))));
      }
      context.done();
      if (error !== undefined) reject(error);
      else resolve();
    };
    this.confirmation = { finish };
    this.options.pending.waitFor(task, () => finish(true));
    const show = () => {
      const item = replacements[index];
      cursor = item.from + delta;
      const from = cm.posFromIndex(item.from + delta),
        to = cm.posFromIndex(item.to + delta);
      cm.setSelection(from, to);
      cm.scrollIntoView(from, 30);
    };
    const replace = () => {
      const item = replacements[index];
      cursor = item.from + delta;
      cm.replaceRange(
        item.text,
        cm.posFromIndex(item.from + delta),
        cm.posFromIndex(item.to + delta),
        "+input",
      );
      delta += item.text.length - (item.to - item.from);
      expected = cm.getValue();
    };
    const document = cm.cm6.dom.ownerDocument;
    const ownerWindow = document.win as Window & { createEl: typeof createEl };
    const template = ownerWindow.createEl("label");
    template.dataset.lindvimeraExConfirm = "true";
    template.append(document.createTextNode("置換しますか？ (y/n/a/q/l) "));
    template.append(ownerWindow.createEl("input"));
    try {
      show();
      close = cm.openDialog(template, undefined, {
        bottom: true,
        closeOnBlur: false,
        closeOnEnter: false,
        onClose: () => finish(),
        onKeyDown: (event: KeyboardEvent) => {
          event.preventDefault();
          event.stopPropagation();
          if (settled) return true;
          const cancel =
            event.key === "Escape" || (event.ctrlKey && ["[", "c"].includes(event.key));
          if (!cancel && !["y", "n", "a", "q", "l"].includes(event.key)) return true;
          try {
            cm.operation(() => {
              if (
                this.options.documentIdentity?.() !== identity ||
                cm.getEditingView() !== target ||
                cm.getValue() !== expected
              )
                throw new Error("置換の確認中に編集対象が変更されました。");
              if (cancel || event.key === "q") {
                finish();
                return;
              }
              if (event.key === "a") {
                while (index < replacements.length) {
                  replace();
                  index++;
                }
                finish();
                return;
              }
              if (event.key !== "n") replace();
              if (event.key === "l" || ++index === replacements.length) finish();
              else show();
            });
          } catch (error) {
            finish(true, error);
          }
          return true;
        },
      });
    } catch (error) {
      finish(true, error);
    }
  }

  cancelConfirmation(): boolean {
    if (!this.confirmation) return false;
    this.confirmation.finish();
    return true;
  }

  reset(): void {
    if (this.confirmation || this.clipboard) this.options.pending.cancel();
  }

  destroy(): void {
    this.disposed = true;
    this.reset();
    if (this.cm.state.exCommandProvider === this.provider)
      this.cm.state.exCommandProvider = this.previous;
  }
}
