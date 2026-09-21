import { EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { dispatchVimKeyEvent, getCM, skipVimKeyEvent, vim, Vim } from "@replit/codemirror-vim";
import type { CodeMirrorV } from "@replit/codemirror-vim-core";
import { EscapeInputSession } from "../input/escape";
import { installCommandPolicy } from "../input/policy";
import {
  escapePreview,
  escapePreviewMoved,
  insertEscapeText,
  showEscapePreview,
} from "../input/escape-preview";
import {
  cancelMarkdownInput,
  clearMarkdown,
  configureMarkdown,
  installMarkdownCommands,
} from "../markdown";
import type { LindvimeraSettings } from "../settings";
import { NativeTableSession } from "../table/session";
import {
  budouxSegmenter,
  installWordProvider,
  WordBoundaryCache,
  type JapaneseSegmenter,
} from "../word";
import { VimHistoryGroup } from "./history";

export interface EditorHost {
  settings(): LindvimeraSettings;
  owner(): unknown;
  wordSegmenter?(): JapaneseSegmenter | undefined;
  modeChanged?(mode: string): void;
  error?(message: string): void;
  openLink?(linktext: string): void;
  inputUI?(event: KeyboardEvent): "none" | "suggestion" | "blocked";
  cancelInputUI?(): boolean;
  focusChanged?(): void;
}

export type InputDecision = "handled" | "host" | "native" | "ime" | "outside";

const sessions = new WeakMap<EditorView, EditorSession>();
interface WordConfiguration {
  japanese: boolean;
  segmenter: JapaneseSegmenter;
  id: string;
}

/** Exactly one instance per parent editor, including all its native table cells. */
export class EditorSession {
  readonly cm: NonNullable<ReturnType<typeof getCM>>;
  readonly table: NativeTableSession;
  private escape: EscapeInputSession;
  private inputTarget: EditorView;
  private removeWords?: () => void;
  private wordConfiguration?: WordConfiguration;
  private pendingWords?: WordConfiguration;
  private wordRefreshScheduled = false;
  private escapeConfiguration = "";
  private warnedTable = false;
  private restoreLifecycle: () => void;
  private restoreInputLifecycle?: () => void;
  private disposed = false;
  private removePolicy: () => void;
  private readonly keyDecisions = new WeakMap<KeyboardEvent, InputDecision>();
  private readonly listeners: [string, EventListener][] = [];

  constructor(
    readonly view: EditorView,
    private host: EditorHost,
    private history: VimHistoryGroup,
  ) {
    const cm = getCM(view);
    if (!cm) throw new Error("Lindvimera engine was not initialized.");
    this.cm = cm;
    this.removePolicy = installCommandPolicy(cm as CodeMirrorV, host.settings, host.error);
    this.inputTarget = view;
    history.attach(cm);
    this.table = new NativeTableSession(cm, {
      resolveOwner: () => host.owner(),
      enabled: () => host.settings().tables,
      inputExtension: history.inputExtension,
      beforeTargetChange: () => {
        this.escape?.flush();
        cancelMarkdownInput(cm as CodeMirrorV);
        this.history.close();
      },
      onError: (message) => host.error?.(`${message} Sourceモードで編集してください。`),
    });
    cm.changeTransformer = (update, changes) => {
      if (
        update.transactions.every(
          (transaction) =>
            transaction.isUserEvent("set") ||
            transaction.annotation(Transaction.addToHistory) === false,
        )
      )
        return [];
      return changes;
    };
    this.escape = new EscapeInputSession(this.escapeSettings(), {
      onPreview: (text) => {
        if (!this.disposed) showEscapePreview(this.inputTarget, text);
      },
      onText: (text) => {
        if (this.disposed) return;
        this.history.begin();
        insertEscapeText(this.inputTarget, text);
      },
      onExit: () => {
        if (this.host.cancelInputUI?.()) return;
        if (cm.state.vim?.insertMode) cm.operation(() => Vim.handleKey(cm, "<Esc>", "user"));
        this.modeChanged();
      },
    });
    // Flush before CodeMirror replaces its state or detaches the editor. A plugin's
    // destroy callback itself runs too late to dispatch a pending literal safely.
    const originalSetState = view.setState;
    const originalDestroy = view.destroy;
    const setState: EditorView["setState"] = (state) => {
      this.finishInsert();
      originalSetState.call(view, state);
    };
    const destroy = () => {
      this.finishInsert();
      originalDestroy.call(view);
    };
    view.setState = setState;
    view.destroy = destroy;
    this.restoreLifecycle = () => {
      if (view.setState === setState) view.setState = originalSetState;
      if (view.destroy === destroy) view.destroy = originalDestroy;
    };
    this.listen("keydown", (event) => this.keydown(event as KeyboardEvent));
    this.listen("beforeinput", (event) => {
      if (!this.isInput(event.target)) return;
      this.switchTarget();
      if (cm.state.vim?.insertMode) this.history.begin();
      else if (!(event as InputEvent).isComposing && !this.inputTarget.composing)
        event.preventDefault();
    });
    for (const name of ["pointerdown", "focusout", "paste", "drop", "compositionstart"])
      this.listen(name, () => this.escape.flush());
    this.listen("focusin", () => {
      this.host.focusChanged?.();
      queueMicrotask(() => {
        if (!this.disposed) {
          this.switchTarget();
          this.modeChanged();
        }
      });
    });
    cm.on("vim-mode-change", this.modeChanged);
    cm.on("vim-command-done", this.scheduleWordConfiguration);
    sessions.set(view, this);
    this.configure();
  }

  private listen(name: string, handler: EventListener): void {
    this.view.dom.addEventListener(name, handler, true);
    this.listeners.push([name, handler]);
  }

  private escapeSettings() {
    const settings = this.host.settings();
    return { sequences: settings.escapeSequences, timeoutMs: settings.escapeTimeoutMs };
  }

  private isInput(target: EventTarget | null): boolean {
    if (!(target instanceof this.view.dom.ownerDocument.defaultView!.HTMLElement)) return false;
    // A cell's panel is nested inside the parent's contentDOM. Only route keys
    // from an editor's own text surface, leaving its search input and controls alone.
    const editor = target.closest(".cm-editor");
    const cell = this.table.nativeInputView();
    if (cell && editor === cell.dom) return cell.contentDOM.contains(target);
    return editor === this.view.dom && this.view.contentDOM.contains(target);
  }

  private hasPendingInput(): boolean {
    const vim = this.cm.state.vim;
    const input = vim?.inputState;
    return !!(
      vim?.expectLiteralNext ||
      input?.operator ||
      input?.keyBuffer.length ||
      input?.prefixRepeat.length ||
      input?.motionRepeat.length ||
      input?.registerName
    );
  }

  cancelPendingInput(): void {
    this.escape.flush();
    cancelMarkdownInput(this.cm as CodeMirrorV);
    Vim.cancelPendingInput(this.cm as CodeMirrorV);
    this.modeChanged();
  }

  private switchTarget(): void {
    this.table.syncTarget();
    const next = this.table.nativeInputView() ?? this.view;
    if (next !== this.inputTarget) {
      this.escape.flush();
      this.restoreInputLifecycle?.();
      this.restoreInputLifecycle = undefined;
      this.inputTarget = next;
      if (next !== this.view) {
        // Native cell editors are recreated independently of their parent editor.
        const originalSetState = next.setState;
        const originalDestroy = next.destroy;
        const setState: EditorView["setState"] = (state) => {
          this.escape.flush();
          originalSetState.call(next, state);
        };
        const destroy = () => {
          this.escape.flush();
          originalDestroy.call(next);
        };
        next.setState = setState;
        next.destroy = destroy;
        this.restoreInputLifecycle = () => {
          if (next.setState === setState) next.setState = originalSetState;
          if (next.destroy === destroy) next.destroy = originalDestroy;
        };
      }
    }
  }

  private keydown(event: KeyboardEvent): void {
    const decision = this.routeKey(event);
    // The owning scope has already offered an unassigned shortcut to Obsidian.
    // If it reaches the editor, do not let a normal-mode key become native editing.
    if (decision === "host" && !this.cm.state.vim?.insertMode && !event.defaultPrevented)
      this.consume(event);
  }

  private consume(event: KeyboardEvent): InputDecision {
    event.preventDefault();
    event.stopImmediatePropagation();
    this.keyDecisions.set(event, "handled");
    return "handled";
  }

  /** Shared by the Markdown scope and DOM capture; even declined keys run once. */
  routeKey(event: KeyboardEvent): InputDecision {
    if (event.defaultPrevented) return "outside";
    const previous = this.keyDecisions.get(event);
    if (previous) return previous;
    if (this.disposed || !this.isInput(event.target)) return "outside";
    this.switchTarget();
    // Stopping a macro does not always emit command-done. Apply the pending
    // configuration before the next independent user command instead.
    this.applyWordConfiguration();
    if (escapePreviewMoved(this.inputTarget)) this.escape.flush();
    const state = this.cm.state.vim;
    if (!state) return "outside";
    const remember = (decision: InputDecision) => {
      this.keyDecisions.set(event, decision);
      return decision;
    };
    if (
      event.isComposing ||
      this.inputTarget.composing ||
      event.key === "Process" ||
      event.key === "Dead"
    ) {
      this.escape.flush();
      skipVimKeyEvent(this.cm, event);
      // Keep browser/IME defaults, but prevent editor and application shortcuts
      // from interpreting the same composition key as another command.
      event.stopImmediatePropagation();
      return remember("ime");
    }
    // Scope/capture runs before CodeMirror's keydown preparation. Flush the last
    // native DOM input before Vim changes mode or reads the document; otherwise
    // a fast final character followed by Escape can be discarded.
    const target = this.inputTarget as EditorView & { observer?: { forceFlush(): void } };
    target.observer?.forceFlush();
    this.switchTarget();
    const ui = this.host.inputUI?.(event) ?? "none";
    if (ui === "blocked") {
      this.escape.flush();
      skipVimKeyEvent(this.cm, event);
      return this.consume(event);
    }
    const cancel =
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey &&
      ((event.key === "Escape" && !event.ctrlKey) || (event.key === "[" && event.ctrlKey));
    if (
      ui === "suggestion" &&
      (cancel ||
        ["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key) ||
        (event.ctrlKey && /^(n|p)$/i.test(event.key)))
    ) {
      this.escape.flush();
      skipVimKeyEvent(this.cm, event);
      if (cancel && this.host.cancelInputUI?.()) return this.consume(event);
      return remember("native");
    }
    const native = this.inputTarget !== this.view;
    if (!native && this.table.isNativeTarget()) {
      if (!this.warnedTable)
        this.host.error?.("テーブルの内部APIを確認できません。Sourceモードで編集してください。");
      this.warnedTable = true;
      return this.consume(event);
    }
    this.warnedTable = false;
    if (
      state.insertMode &&
      !this.cm.state.overwrite &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !Vim.getVimGlobalState_().macroModeState.isPlaying
    ) {
      if (
        this.escape.handleKey({
          key: event.key,
          repeat: event.repeat,
          composing: event.isComposing || this.inputTarget.composing,
        })
      ) {
        skipVimKeyEvent(this.cm, event);
        return this.consume(event);
      }
    } else this.escape.flush();
    const pending = this.hasPendingInput();
    const result = dispatchVimKeyEvent(this.cm, event, this.inputTarget);
    this.modeChanged();
    if (result === "handled") return this.consume(event);
    // Escape never leaves the editing surface, including when already Normal.
    if (cancel) {
      this.cancelPendingInput();
      return this.consume(event);
    }
    if (
      native &&
      state.insertMode &&
      (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      this.escape.flush();
      const key = `${event.shiftKey ? "Shift-" : ""}${event.key}`;
      const api = Vim as typeof Vim & {
        recordNativeInputKey(cm: EditorSession["cm"], key: string): (() => void) | undefined;
      };
      const rollback = api.recordNativeInputKey(this.cm, key);
      if (this.table.nativeKey(key)) {
        this.switchTarget();
        this.modeChanged();
        return this.consume(event);
      }
      rollback?.();
    }
    if (native && state.insertMode) {
      const api = Vim as typeof Vim & {
        recordInsertModeKey(cm: EditorSession["cm"], event: KeyboardEvent): void;
      };
      api.recordInsertModeKey(this.cm, event);
    }
    if (!state.insertMode) {
      this.cancelPendingInput();
      if (pending && !event.ctrlKey && !event.altKey && !event.metaKey) return this.consume(event);
    }
    return remember(result === "native" ? "native" : "host");
  }

  private readonly modeChanged = () => {
    const vimState = this.cm.state.vim;
    const mode = vimState?.insertMode
      ? this.cm.state.overwrite
        ? "REPLACE"
        : "INSERT"
      : vimState?.visualBlock
        ? "VISUAL BLOCK"
        : vimState?.visualLine
          ? "VISUAL LINE"
          : vimState?.visualMode
            ? "VISUAL"
            : "NORMAL";
    this.view.dom.dataset.lindvimeraMode = mode;
    const pending = this.hasPendingInput() ? (vimState?.status ?? "") : "";
    const macro = Vim.getVimGlobalState_().macroModeState;
    this.host.modeChanged?.(
      [mode, pending, macro.isRecording ? `recording @${macro.latestRegister}` : ""]
        .filter(Boolean)
        .join(" · "),
    );
  };

  refreshMode(): void {
    this.modeChanged();
  }

  private readonly scheduleWordConfiguration = () => {
    if (!this.pendingWords || this.wordRefreshScheduled) return;
    this.wordRefreshScheduled = true;
    queueMicrotask(() => {
      this.wordRefreshScheduled = false;
      if (!this.disposed) this.applyWordConfiguration();
    });
  };

  private wordConfigurationBlocked(): boolean {
    const state = this.cm.state.vim;
    const input = state?.inputState;
    const macro = Vim.getVimGlobalState_().macroModeState;
    return !!(
      this.cm.curOp ||
      macro.isRecording ||
      macro.isPlaying ||
      state?.expectLiteralNext ||
      input?.operator ||
      input?.motion ||
      input?.keyBuffer.length ||
      input?.prefixRepeat.length ||
      input?.motionRepeat.length ||
      input?.registerName
    );
  }

  private applyWordConfiguration(): void {
    const next = this.pendingWords;
    if (!next || (this.wordConfiguration && this.wordConfigurationBlocked())) return;
    this.removeWords?.();
    this.removeWords = installWordProvider(
      this.cm,
      new WordBoundaryCache(512, 262_144, next.japanese, next.segmenter),
    );
    this.wordConfiguration = next;
    this.pendingWords = undefined;
  }

  configure(): void {
    const settings = this.host.settings();
    const escapeSettings = this.escapeSettings();
    const fingerprint = JSON.stringify(escapeSettings);
    if (fingerprint !== this.escapeConfiguration) {
      this.escape.configure(escapeSettings);
      this.escapeConfiguration = fingerprint;
    }
    const segmenter = this.host.wordSegmenter?.() ?? budouxSegmenter;
    if (
      this.wordConfiguration?.japanese === settings.japanese &&
      this.wordConfiguration.segmenter === segmenter &&
      this.wordConfiguration.id === segmenter.id
    ) {
      this.pendingWords = undefined;
    } else {
      this.pendingWords = { japanese: settings.japanese, segmenter, id: segmenter.id };
      this.applyWordConfiguration();
      this.scheduleWordConfiguration();
    }
    configureMarkdown(this.cm, {
      motions: settings.markdownMotions,
      textObjects: settings.textObjects,
      surround: settings.surround,
      openLink: this.host.openLink,
    });
    this.modeChanged();
  }

  flush(): void {
    this.escape.flush();
  }

  finishInsert(): void {
    this.escape.flush();
    if (this.cm.state.vim?.insertMode)
      this.cm.operation(() => Vim.handleKey(this.cm, "<Esc>", "user"));
  }

  destroy(): void {
    this.disposed = true;
    this.restoreLifecycle();
    this.restoreInputLifecycle?.();
    this.escape.dispose();
    for (const [name, handler] of this.listeners)
      this.view.dom.removeEventListener(name, handler, true);
    this.cm.off("vim-mode-change", this.modeChanged);
    this.cm.off("vim-command-done", this.scheduleWordConfiguration);
    this.pendingWords = undefined;
    this.table.destroy();
    this.removePolicy();
    this.removeWords?.();
    clearMarkdown(this.cm);
    this.history.destroy();
    delete this.cm.changeTransformer;
    delete this.cm.inputViewProvider;
    delete this.view.dom.dataset.lindvimeraMode;
    sessions.delete(this.view);
  }
}

export function editorSession(view: EditorView): EditorSession | undefined {
  return sessions.get(view);
}

export function lindvimeraEditor(host: EditorHost): Extension {
  installMarkdownCommands();
  const group = new VimHistoryGroup();
  return [
    vim(),
    EditorState.allowMultipleSelections.of(true),
    escapePreview,
    group.extension,
    ViewPlugin.define((view) => new EditorSession(view, host, group)),
  ];
}
