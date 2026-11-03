import {
  Annotation,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import type { ViewUpdate } from "@codemirror/view";
import { parseEx, unescapeReplacement } from "../../input/ex-syntax";
import type { KeyBinding } from "../../settings";
import type { NativeCM, NativeCommand, NativeVim } from "./native";

interface QueueOptions {
  liveTargetCM(): NativeCM | undefined;
  isActive(): boolean;
  dispatch(cm: NativeCM, key: string, origin?: string): unknown;
  onError?(error: unknown): void;
}
export interface NativeContinuation {
  run(cm: NativeCM): void;
  cancel?(): void;
}
type QueueEntry =
  | { key: string; origin?: string }
  | { continuation: NativeContinuation }
  | { implicitSubmit: true };
interface NativeFrame {
  boundary(): NativeContinuation | undefined;
  bounded: boolean;
  canceled: boolean;
  pending: QueueEntry[];
  continuation?: NativeContinuation;
}
interface DispatchFrame {
  cm: NativeCM;
  available: boolean;
  canceled: boolean;
  pending: QueueEntry[];
}
const bridges = new WeakMap<NativeCM, NativeExBridge>();
const tokens = (sequence: string) => sequence.match(/<(?:[CSMA]-)*(?:\w+|[^\s<>])>|./gu) ?? [];
const cancelKey = (key: string) => /^(?:<Esc>|<C-c>|<C-\[>)$/iu.test(key);

/** One logical editor queue; targets are resolved again after native cell restoration. */
export class NativeCommandQueue {
  private keys: QueueEntry[] = [];
  private nativeFrames: NativeFrame[] = [];
  private dispatchFrame?: DispatchFrame;
  private waiting = new Map<symbol, () => void>();
  private tasks = new Set<Promise<void>>();
  private groups = new Set<NativeExBridge>();
  private scheduled = false;
  private draining = false;
  private disposed = false;
  constructor(private options: QueueOptions) {}

  waitFor(task: Promise<void>, cancel: () => void): void {
    if (this.disposed) {
      cancel();
      return;
    }
    this.boundNativeFrames();
    const token = Symbol();
    let unblock!: () => void;
    const canceled = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    this.waiting.set(token, () => {
      try {
        cancel();
      } finally {
        unblock();
      }
    });
    const observed = Promise.race([task, canceled])
      .catch(() => {
        this.cancel();
      })
      .finally(() => {
        this.waiting.delete(token);
        this.tasks.delete(observed);
        this.schedule();
      });
    this.tasks.add(observed);
  }

  intercept(cm: NativeCM, key: string, origin?: string): false | (() => true) {
    if (this.disposed) return false;
    const native = this.nativeFrames.at(-1);
    if (native && !native.bounded) return false;
    const frame = this.dispatchFrame;
    if (!native && frame?.available && frame.cm === cm) {
      frame.available = false;
      return false;
    }
    if (!native && frame && !this.waiting.size && !frame.pending.length) return false;
    if (!native && !frame && !this.waiting.size && !this.keys.length && !this.scheduled)
      return false;
    return () => {
      if (native?.canceled || frame?.canceled) return true;
      if (cancelKey(key) && origin !== "macro" && origin !== "mapping") this.cancel();
      else {
        if (native) native.pending.push({ key, origin });
        else if (frame) frame.pending.push({ key, origin });
        else this.keys.push({ key, origin });
        this.schedule();
      }
      return true;
    };
  }

  run(sequence: string, origin = "mapping", implicitSubmit = false): void {
    if (this.disposed) return;
    this.boundNativeFrames();
    const entries: QueueEntry[] = tokens(sequence).map((key) => ({ key, origin }));
    if (implicitSubmit) entries.push({ implicitSubmit: true });
    this.enqueue(entries);
    this.schedule();
  }

  /** Run one native synchronous replay segment; its owned buffer is truncated at the first boundary. */
  withNativeFrame<T>(run: () => T, onBoundary: () => NativeContinuation | undefined): T {
    const frame: NativeFrame = {
      boundary: onBoundary,
      bounded: false,
      canceled: false,
      pending: [],
    };
    this.nativeFrames.push(frame);
    try {
      return run();
    } catch (error) {
      this.cancel();
      throw error;
    } finally {
      this.nativeFrames.pop();
      if (!frame.canceled) {
        if (frame.continuation) frame.pending.push({ continuation: frame.continuation });
        if (frame.pending.length) {
          this.enqueue(frame.pending, true);
          this.schedule();
        }
      }
    }
  }

  private boundNativeFrames(): void {
    for (const frame of [...this.nativeFrames].reverse()) {
      if (frame.bounded) continue;
      frame.bounded = true;
      frame.continuation = frame.boundary();
    }
  }

  private enqueue(entries: QueueEntry[], beforeTail = false): void {
    const native = this.nativeFrames.at(-1);
    if (native) {
      if (!native.canceled) native.pending.push(...entries);
    } else if (this.dispatchFrame) {
      if (!this.dispatchFrame.canceled) this.dispatchFrame.pending.push(...entries);
    } else if (beforeTail || this.draining) this.keys.unshift(...entries);
    else this.keys.push(...entries);
  }

  hold(bridge: NativeExBridge): void {
    this.groups.add(bridge);
    bridge.beginQueueGroup();
  }

  private releaseGroups(abort = false): void {
    const groups = [...this.groups];
    this.groups.clear();
    for (const bridge of groups) bridge.endQueueGroup(abort);
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.disposed || this.draining || this.waiting.size) return;
    if (!this.options.isActive()) {
      this.cancel();
      return;
    }
    this.draining = true;
    try {
      while (this.keys.length && !this.waiting.size && this.options.isActive()) {
        const cm = this.options.liveTargetCM();
        if (!cm) {
          this.cancel();
          return;
        }
        const bridge = bridges.get(cm);
        if (bridge) this.hold(bridge);
        const entry = this.keys.shift()!;
        if ("implicitSubmit" in entry) continue;
        if ("continuation" in entry) {
          const run = () => entry.continuation.run(cm);
          if (bridge) bridge.queueOperation(run);
          else run();
          continue;
        }
        if (
          entry.key === ":" &&
          !cm.state.vim?.insertMode &&
          !cm.state.vim?.expectLiteralNext &&
          bridges.has(cm)
        ) {
          let end = -1;
          let preview = cm.state.vim?.visualMode ? "'<,'>" : "";
          for (let i = 0; i < this.keys.length; i++) {
            const item = this.keys[i];
            if ("implicitSubmit" in item) {
              end = i;
              break;
            }
            if (!("key" in item)) break;
            if (
              /^<(?:CR|Enter)>$/iu.test(item.key) ||
              cancelKey(item.key) ||
              (/^<BS>$/iu.test(item.key) && !preview)
            ) {
              end = i;
              break;
            }
            if (/^<BS>$/iu.test(item.key)) preview = [...preview].slice(0, -1).join("");
            else if (/^<C-u>$/iu.test(item.key)) preview = "";
            else preview += item.key;
          }
          if (end >= 0) {
            let input = cm.state.vim?.visualMode ? "'<,'>" : "";
            let canceled = false;
            const prompt = this.keys.splice(0, end + 1);
            for (let i = 0; i < prompt.length; i++) {
              const item = prompt[i];
              if ("implicitSubmit" in item) break;
              if (!("key" in item)) continue;
              if (/^<(?:CR|Enter)>$/iu.test(item.key)) break;
              if (cancelKey(item.key) || (/^<BS>$/iu.test(item.key) && !input)) {
                this.keys.unshift(...prompt.slice(i + 1));
                canceled = true;
                break;
              }
              if (/^<BS>$/iu.test(item.key)) input = [...input].slice(0, -1).join("");
              else if (/^<C-u>$/iu.test(item.key)) input = "";
              else
                input += /^<Space>$/iu.test(item.key)
                  ? " "
                  : /^<lt>$/iu.test(item.key)
                    ? "<"
                    : item.key;
            }
            if (canceled) {
              continue;
            }
            bridges.get(cm)!.execute(input);
            continue;
          }
        }
        const prior = this.dispatchFrame;
        const frame: DispatchFrame = { cm, available: true, canceled: false, pending: [] };
        this.dispatchFrame = frame;
        const dispatch = () => {
          const handled = this.options.dispatch(cm, entry.key, entry.origin);
          if (!handled && cm.state.vim?.insertMode) {
            const text =
              entry.key === "<Space>"
                ? " "
                : entry.key === "<lt>"
                  ? "<"
                  : entry.key === "<CR>"
                    ? "\n"
                    : entry.key;
            if ([...text].length === 1)
              cm.cm6.dispatch(cm.cm6.state.replaceSelection(text), { userEvent: "input.type" });
          }
        };
        try {
          if (bridge) bridge.queueOperation(dispatch);
          else dispatch();
        } finally {
          this.dispatchFrame = prior;
          if (!frame.canceled && frame.pending.length) this.enqueue(frame.pending, true);
        }
      }
    } catch (error) {
      this.cancel();
      if (this.options.onError) this.options.onError(error);
      else throw error;
    } finally {
      this.draining = false;
      if (!this.options.isActive()) this.cancel();
      else if (!this.waiting.size && !this.keys.length) this.releaseGroups();
    }
  }

  cancel(): void {
    this.boundNativeFrames();
    const entries = this.keys;
    this.keys = [];
    if (this.dispatchFrame) {
      this.dispatchFrame.canceled = true;
      entries.push(...this.dispatchFrame.pending.splice(0));
    }
    for (const frame of this.nativeFrames) {
      frame.canceled = true;
      entries.push(...frame.pending.splice(0));
      if (frame.continuation) {
        entries.push({ continuation: frame.continuation });
        frame.continuation = undefined;
      }
    }
    for (const entry of entries) if ("continuation" in entry) entry.continuation.cancel?.();
    const callbacks = [...this.waiting.values()];
    this.waiting.clear();
    for (const callback of callbacks) callback();
    this.releaseGroups(true);
  }
  async settled(): Promise<void> {
    do {
      await Promise.all(this.tasks);
      await Promise.resolve();
    } while (this.tasks.size || this.scheduled || this.draining);
  }
  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}

/** Preserve the shared JS replacement contract before the native Vim parser decodes it. */
export function nativeReplacementInput(input: string, pcre = true): string {
  let syntax;
  try {
    syntax = parseEx(input, { pcre: false });
  } catch {
    return input;
  }
  const substitution = syntax.substitution;
  if (!substitution) return input;
  const { delimiter, replacement } = substitution;
  let to = input.lastIndexOf(delimiter);
  if (input.slice(to - replacement.length, to) !== replacement) to = input.length;
  const from = to - replacement.length;
  if (from < 0 || input.slice(from, to) !== replacement) return input;
  const desired = unescapeReplacement(replacement, delimiter);
  const literal = (character: string) => {
    if (character === "\\") return "\\\\";
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    if (character === delimiter || (pcre && character === "&")) return "\\" + character;
    if (pcre && character === "$") return "$$";
    return character;
  };
  let encoded = "";
  for (let at = 0; at < desired.length; at++) {
    const token = /^\$(\$|&|[1-9][0-9]?)/u.exec(desired.slice(at));
    if (token) {
      encoded += pcre
        ? token[0].replace("&", "\\&")
        : token[1] === "$"
          ? "$"
          : "\\" + (token[1] === "&" ? "0" : token[1]);
      at += token[0].length - 1;
    } else encoded += literal(desired[at]);
  }
  return input.slice(0, from) + encoded + input.slice(to);
}

type CloseDialog = (value?: string) => void;
interface DialogOptions {
  onKeyDown?(event: KeyboardEvent, value: string, close: CloseDialog): unknown;
  onClose?(element?: HTMLElement): void;
  [key: string]: unknown;
}
interface SearchCursor {
  match?: (string | undefined)[];
  pos?: { match?: (string | undefined)[] };
  findNext?: (this: SearchCursor, ...args: unknown[]) => unknown;
}
interface DialogCM extends NativeCM {
  focus?: (this: DialogCM) => void;
  openDialog?: (
    this: DialogCM,
    template: Node | string,
    submit: ((value: string) => void) | undefined,
    options?: DialogOptions,
  ) => CloseDialog;
  getSearchCursor?: (this: DialogCM, ...args: unknown[]) => SearchCursor;
}
function recordingClose(
  cm: DialogCM,
  close: CloseDialog,
  lifetime: WeakRef<NativeExBridge>,
): CloseDialog {
  return (value) => {
    const activeEditor = cm.cm6.dom.ownerDocument.activeElement?.closest(".cm-editor");
    const focus = cm.focus;
    if (!lifetime.deref()?.activeNow() || !focus || !activeEditor || activeEditor === cm.cm6.dom)
      return close(value);
    // The native recording notification belongs to its original adapter; closing
    // it must not steal focus from a later cell and destroy that cell mid-command.
    const hold = () => {};
    cm.focus = hold;
    try {
      close(value);
    } finally {
      if (cm.focus === hold) cm.focus = focus;
    }
  };
}
type HandleEx = (this: NativeVim, cm: NativeCM, input: string) => unknown;
const definitions = new WeakSet<NativeVim>();
const exWrappers = new WeakMap<
  NativeVim,
  { count: number; active: boolean; previous: HandleEx; owned: HandleEx }
>();
const actionName = "lindvimera115_exMapping";
const viewAlive = (cm: NativeCM) => !(cm.cm6 as unknown as { destroyed: boolean }).destroyed;
let nextGroup = 1;
const groupAnnotation = Annotation.define<number>();
const groupField = StateField.define<number>({
  create: () => 0,
  update: (value, transaction) =>
    transaction.docChanged ? (transaction.annotation(groupAnnotation) ?? 0) : value,
});

/** Native parser/ranges/search/confirmation execute unchanged; only input and continuation are adapted. */
export class NativeExBridge {
  private disposed = false;
  private group = 0;
  private nativeDepth = 0;
  private insertGroup = false;
  private queueGroup = false;
  private pending = false;
  private releaseDialog?: () => void;
  private compartment = new Compartment();
  private restore: (() => void)[] = [];

  constructor(
    readonly cm: NativeCM,
    private vim: NativeVim,
    readonly queue: NativeCommandQueue,
    private isActive: () => boolean,
    private documentIdentity: () => unknown = () => cm.cm6,
  ) {
    bridges.set(cm, this);
    if (!definitions.has(vim)) {
      vim.defineAction(actionName, (target, args) => {
        const bridge = bridges.get(target);
        if (bridge && typeof args.rhs === "string") {
          const prefix =
            !target.state.vim?.visualMode && args.repeat > 1 ? `.,.+${args.repeat - 1}` : "";
          bridge.queue.run(
            args.rhs.startsWith(":") ? ":" + prefix + args.rhs.slice(1) : args.rhs,
            "mapping",
            args.implicitSubmit === true,
          );
        }
      });
      definitions.add(vim);
    }
    this.installExWrapper();
    this.installDialogs();
    cm.cm6.dispatch({
      effects: StateEffect.appendConfig.of(
        this.compartment.of([
          groupField,
          EditorState.transactionFilter.of((transaction) => {
            if (
              !this.group ||
              (!this.nativeDepth && !this.insertGroup) ||
              !transaction.docChanged ||
              transaction.isUserEvent("undo") ||
              transaction.isUserEvent("redo") ||
              transaction.isUserEvent("set") ||
              transaction.annotation(Transaction.addToHistory) === false
            )
              return transaction;
            const continuing = transaction.startState.field(groupField) === this.group;
            return [
              {
                annotations: [
                  groupAnnotation.of(this.group),
                  Transaction.userEvent.of("input.type.compose"),
                  ...(continuing ? [] : [isolateHistory.of("before")]),
                ],
              },
              transaction,
            ];
          }),
        ]),
      ),
    });
  }

  mapping(binding: KeyBinding): NativeCommand {
    return {
      keys: binding.from,
      type: "action",
      context: binding.mode,
      action: actionName,
      actionArgs: { rhs: binding.to, implicitSubmit: !/<CR>/iu.test(binding.to) },
    };
  }

  execute(input: string): void {
    const handleEx = this.vim.handleEx as HandleEx | undefined;
    if (typeof handleEx === "function" && this.isActive() && !this.disposed)
      this.cm.operation(() => handleEx.call(this.vim, this.cm, input));
  }

  private nativeCall(run: () => unknown): unknown {
    if (this.disposed || !this.isActive()) return;
    if (!this.group) this.group = nextGroup++;
    this.nativeDepth++;
    try {
      return run();
    } finally {
      this.nativeDepth--;
      if (!this.pending && !this.queueGroup && !this.insertGroup) this.group = 0;
    }
  }

  private input(value: string): string {
    // Preserve native method identity; Reflect.apply supplies its original owner.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply preserves the native receiver.
    const getter = this.vim.getOption;
    return nativeReplacementInput(
      value,
      !getter || Reflect.apply(getter, this.vim, ["pcre", this.cm]) !== false,
    );
  }

  private installExWrapper(): void {
    let wrapper = exWrappers.get(this.vim);
    if (!wrapper) {
      const previous = this.vim.handleEx as HandleEx;
      if (typeof previous !== "function") return;
      const lifetime = {
        count: 0,
        active: true,
        previous,
        owned: undefined as unknown as HandleEx,
      };
      lifetime.owned = function (cm, input) {
        const bridge = lifetime.active && bridges.get(cm);
        return bridge && bridge.isActive() && !bridge.disposed
          ? bridge.nativeCall(() => previous.call(this, cm, bridge.input(input)))
          : previous.call(this, cm, input);
      };
      this.vim.handleEx = lifetime.owned;
      exWrappers.set(this.vim, lifetime);
      wrapper = lifetime;
    }
    wrapper.count++;
    this.restore.push(() => {
      if (--wrapper.count) return;
      wrapper.active = false;
      if (this.vim.handleEx === wrapper.owned) this.vim.handleEx = wrapper.previous;
      exWrappers.delete(this.vim);
    });
  }

  private installDialogs(): void {
    const cm = this.cm as DialogCM;
    const previous = cm.openDialog;
    if (previous) {
      const reference = new WeakRef(this);
      const owned: NonNullable<DialogCM["openDialog"]> = function (template, submit, options = {}) {
        const bridge = reference.deref();
        const text = typeof template === "string" ? template : (template.textContent ?? "");
        if (!bridge || bridge.disposed || !bridge.isActive())
          return previous.call(cm, template, submit, options);
        if (text.startsWith("(recording)"))
          return recordingClose(cm, previous.call(cm, template, submit, options), reference);
        if (submit && text.trimStart().startsWith(":")) {
          const identity = bridge.documentIdentity();
          return previous.call(
            cm,
            template,
            (value) => {
              if (bridge.documentIdentity() === identity)
                bridge.nativeCall(() => submit(bridge.input(value)));
            },
            options,
          );
        }
        if (!text.includes("(y/n/a/q/l)")) return previous.call(cm, template, submit, options);
        bridge.pending = true;
        if (!bridge.group) bridge.group = nextGroup++;
        bridge.queue.hold(bridge);
        let allowed = false;
        let closed = false;
        const identity = bridge.documentIdentity();
        let resolve!: () => void;
        const task = new Promise<void>((done) => {
          resolve = done;
        });
        const finish = () => {
          if (closed) return;
          closed = true;
          bridge.pending = false;
          bridge.releaseDialog = undefined;
          if (!allowed) bridge.queue.cancel();
          // Native stop(close) restores the final search position after close returns.
          queueMicrotask(() => {
            if (!bridge.queueGroup && !bridge.insertGroup) bridge.group = 0;
            if (bridge.disposed || !bridge.isActive()) bridge.queue.cancel();
            resolve();
          });
        };
        const close = previous.call(cm, template, submit, {
          ...options,
          onKeyDown(event, value, nativeClose) {
            if (closed || bridge.disposed) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
            if (!bridge.isActive() || bridge.documentIdentity() !== identity) {
              event.preventDefault();
              event.stopPropagation();
              bridge.cancelPending();
              return true;
            }
            const controlCancel =
              event.ctrlKey &&
              !event.altKey &&
              !event.metaKey &&
              (event.key === "c" || event.key === "[");
            allowed =
              controlCancel ||
              (!event.ctrlKey &&
                !event.metaKey &&
                (/^[ynalq]$/u.test(event.key) || event.key === "Escape"));
            bridge.nativeDepth++;
            try {
              if (controlCancel) {
                // Native 1.15 spells these cases Ctrl- but emits C-. Finishing
                // through its Escape path preserves the existing partial-result continuation.
                event.preventDefault();
                event.stopPropagation();
                const Event = cm.cm6.dom.ownerDocument.defaultView!.KeyboardEvent;
                return options.onKeyDown?.(
                  new Event("keydown", { key: "Escape" }),
                  value,
                  nativeClose,
                );
              }
              return options.onKeyDown?.(event, value, nativeClose);
            } finally {
              bridge.nativeDepth--;
              if (!closed) allowed = false;
            }
          },
          onClose(element) {
            options.onClose?.(element);
            finish();
          },
        });
        bridge.releaseDialog = () => {
          allowed = false;
          finish();
          queueMicrotask(() => {
            if (viewAlive(cm) && bridge.documentIdentity() === identity) {
              const Event = cm.cm6.dom.ownerDocument.defaultView!.KeyboardEvent;
              options.onKeyDown?.(new Event("keydown", { key: "Escape" }), "", close);
            }
            close();
          });
        };
        bridge.queue.waitFor(task, bridge.releaseDialog);
        return close;
      };
      cm.openDialog = owned;
      this.restore.push(() => {
        if (cm.openDialog === owned) cm.openDialog = previous;
      });
    }
    const search = cm.getSearchCursor;
    if (search) {
      const reference = new WeakRef(this);
      const owned: NonNullable<DialogCM["getSearchCursor"]> = function (...args) {
        const cursor = search.apply(cm, args);
        const bridge = reference.deref();
        if (!bridge || bridge.disposed || !bridge.group) return cursor;
        const normalize = () => {
          for (const match of [cursor.match, cursor.pos?.match])
            if (match) {
              for (let i = 0; i < match.length; i++) if (match[i] === undefined) match[i] = "";
              if (match.length > 100) match.length = 100;
            }
        };
        const find = cursor.findNext;
        if (find)
          cursor.findNext = function (...values) {
            const result = find.apply(this, values);
            normalize();
            return result;
          };
        normalize();
        return cursor;
      };
      cm.getSearchCursor = owned;
      this.restore.push(() => {
        if (cm.getSearchCursor === owned) cm.getSearchCursor = search;
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseDialog?.();
    for (const restore of this.restore.reverse()) restore();
    this.restore = [];
    if (bridges.get(this.cm) === this) bridges.delete(this.cm);
    this.group = 0;
    this.isActive = () => false;
    this.documentIdentity = () => undefined;
    queueMicrotask(() => {
      if (viewAlive(this.cm)) this.cm.cm6.dispatch({ effects: this.compartment.reconfigure([]) });
    });
  }

  cancelPending(): void {
    this.queue.cancel();
    this.releaseDialog?.();
    this.group = 0;
    this.insertGroup = false;
  }

  activeNow(): boolean {
    return !this.disposed && this.isActive();
  }

  beginInsertGroup(): void {
    if (this.disposed || !this.isActive() || this.pending) return;
    if (!this.insertGroup) this.group = nextGroup++;
    this.insertGroup = true;
  }

  endInsertGroup(): void {
    this.insertGroup = false;
    if (!this.pending && !this.queueGroup) this.group = 0;
  }

  beginQueueGroup(): void {
    if (!this.group) this.group = nextGroup++;
    this.queueGroup = true;
  }

  endQueueGroup(abort = false): void {
    this.queueGroup = false;
    if (abort) this.insertGroup = false;
    else if (this.cm.state.vim?.insertMode) this.insertGroup = true;
    if (abort || (!this.pending && !this.insertGroup)) this.group = 0;
  }

  queueOperation(run: () => void): void {
    this.nativeDepth++;
    try {
      run();
    } finally {
      this.nativeDepth--;
    }
  }

  onUpdate(update: ViewUpdate): void {
    if (
      this.insertGroup &&
      update.docChanged &&
      update.transactions.some(
        (transaction) => transaction.annotation(groupAnnotation) !== this.group,
      )
    )
      this.endInsertGroup();
    if (
      this.pending &&
      update.docChanged &&
      update.transactions.some(
        (transaction) => transaction.annotation(groupAnnotation) !== this.group,
      )
    )
      this.cancelPending();
  }
}
