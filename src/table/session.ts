import { Compartment, EditorSelection, StateEffect, type Extension } from "@codemirror/state";
import { runScopeHandlers, type EditorView } from "@codemirror/view";
import { getCM, Vim, vimTarget } from "@replit/codemirror-vim";
import type { CodeMirrorV } from "@replit/codemirror-vim-core";
import { nativeCellIdentity, nativeInputView, resolveNativeTable } from "./native-adapter";
import type { NativeTableContext } from "./native-adapter";

type Engine = NonNullable<ReturnType<typeof getCM>>;
const sessions = new WeakMap<object, NativeTableSession>();
let commandsInstalled = false;

export interface NativeTableSessionOptions {
  resolveOwner(): unknown;
  enabled?(): boolean;
  beforeTargetChange?(): void;
  afterTargetChange?(): void;
  inputExtension?: Extension;
  onError?(message: string): void;
}

export function installTableCommands(): void {
  if (commandsInstalled) return;
  commandsInstalled = true;
  Vim.defineAction("lindvimeraCell", (cm, args) => {
    sessions.get(cm)?.move(args.forward !== false, args.repeat ?? 1);
  });
  Vim.defineAction("lindvimeraLeaveTable", (cm, args) => {
    sessions.get(cm)?.leave(args.forward === false ? "before" : "after");
  });
  for (const [key, forward] of [
    ["<Tab>", true],
    ["<S-Tab>", false],
  ] as const) {
    for (const context of ["normal", "visual", "operatorPending"] as const) {
      Vim.mapCommand(
        key,
        "action",
        "lindvimeraCell",
        { forward },
        {
          context,
          cancelPendingOperator: true,
          when: (cm: Engine) => !!sessions.get(cm)?.nativeInputView(),
        },
      );
    }
  }
  for (const [key, forward] of [
    ["[t", false],
    ["]t", true],
  ] as const) {
    Vim.mapCommand(
      key,
      "action",
      "lindvimeraLeaveTable",
      { forward },
      {
        context: "normal",
        when: (cm: Engine) => !!sessions.get(cm)?.nativeInputView(),
      },
    );
  }
}

/** One parent Vim session; cells supply editing surfaces, never another engine. */
export class NativeTableSession {
  private target: EditorView;
  private targetIdentity?: string;
  private readonly attachments = new Map<
    EditorView,
    { compartment: Compartment; release(): void }
  >();
  private reportedReason = "";

  constructor(
    readonly cm: Engine,
    private readonly options: NativeTableSessionOptions,
  ) {
    this.target = cm.cm6;
    sessions.set(cm, this);
    installTableCommands();
    cm.editingViewProvider = () => this.nativeInputView() ?? cm.cm6;
    cm.inputViewProvider = cm.editingViewProvider;
    cm.nativeInputHandler = (key) => this.nativeKey(key);
  }

  nativeInputView(): EditorView | undefined {
    if (this.options.enabled?.() === false) return;
    return nativeInputView(this.options.resolveOwner(), this.cm.cm6);
  }

  isNativeTarget(): boolean {
    if (this.options.enabled?.() === false) return false;
    const owner = this.options.resolveOwner();
    return !!(owner && typeof owner === "object" && "tableCell" in owner && owner.tableCell);
  }

  private context(): NativeTableContext | undefined {
    if (!this.isNativeTarget()) return;
    const result = resolveNativeTable(this.options.resolveOwner(), this.cm.cm6);
    if (result.supported) {
      this.reportedReason = "";
      return result.context;
    }
    if (this.reportedReason !== result.reason) {
      this.reportedReason = result.reason;
      this.options.onError?.(result.reason);
    }
  }

  /** Call before dispatching a Vim key and after host focus/navigation changes. */
  syncTarget(): void {
    const next = this.nativeInputView() ?? this.cm.cm6;
    const identity =
      next === this.cm.cm6
        ? undefined
        : nativeCellIdentity(this.options.resolveOwner(), this.cm.cm6);
    if (next === this.target) {
      this.targetIdentity = identity;
      return;
    }
    const regenerated = identity !== undefined && identity === this.targetIdentity;
    if (!regenerated) {
      this.options.beforeTargetChange?.();
      if (!this.cm.state.vim?.insertMode) {
        // Host focus may already have destroyed the old view. Cancel the old
        // command without applying its Visual coordinates to the new cell.
        const head = next.state.selection.main.head;
        this.cm.operation(() => Vim.handleKey(this.cm, "<Esc>", "user"));
        next.dispatch({ selection: EditorSelection.cursor(head) });
      }
    }
    this.target = next;
    this.targetIdentity = identity;
    if (next !== this.cm.cm6 && !this.attachments.has(next)) {
      const compartment = new Compartment();
      const originalDestroy = next.destroy;
      const destroy = () => {
        this.attachments.delete(next);
        originalDestroy.call(next);
      };
      next.destroy = destroy;
      this.attachments.set(next, {
        compartment,
        release() {
          if (next.destroy === destroy) next.destroy = originalDestroy;
        },
      });
      next.dispatch({
        effects: StateEffect.appendConfig.of(
          compartment.of([vimTarget(() => this.cm), this.options.inputExtension ?? []]),
        ),
      });
    }
    this.cm.refreshEditingTarget(regenerated);
    this.options.afterTargetChange?.();
  }

  move(forward: boolean, count = 1): void {
    const context = this.context();
    const current = context?.currentCell;
    if (!context || !current) return;
    const model = context.snapshot();
    const width = model.rows[0]!.length;
    const index = current.row * width + current.column;
    const next = Math.max(
      0,
      Math.min(model.rows.length * width - 1, index + (forward ? 1 : -1) * Math.max(1, count)),
    );
    if (next === index) return;
    this.options.beforeTargetChange?.();
    if (this.cm.state.vim?.visualMode) Vim.exitVisualMode(this.cm as CodeMirrorV);
    context.focus({ row: Math.floor(next / width), column: next % width, offset: 0 });
    this.syncTarget();
  }

  leave(direction: "before" | "after"): void {
    const context = this.context();
    if (!context || !context.canLeave(direction)) return;
    this.options.beforeTargetChange?.();
    context.leave(direction);
    this.syncTarget();
  }

  /** The native handler runs once, both for physical input and insertion replay. */
  nativeKey(key: string): boolean {
    const view = this.nativeInputView();
    if (!view || !["Tab", "Shift-Tab", "Enter", "Shift-Enter"].includes(key)) return false;
    this.options.beforeTargetChange?.();
    const event = new KeyboardEvent("keydown", {
      key: key.endsWith("Tab") ? "Tab" : "Enter",
      shiftKey: key.startsWith("Shift-"),
      bubbles: true,
      cancelable: true,
    });
    const handled = runScopeHandlers(view, event, "editor");
    this.syncTarget();
    return handled;
  }

  destroy(): void {
    for (const [view, attachment] of this.attachments) {
      attachment.release();
      view.dispatch({ effects: attachment.compartment.reconfigure([]) });
    }
    this.attachments.clear();
    sessions.delete(this.cm);
    delete this.cm.editingViewProvider;
    delete this.cm.inputViewProvider;
    delete this.cm.nativeInputHandler;
    this.cm.refreshEditingTarget();
  }
}
