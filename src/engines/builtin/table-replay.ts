import type { EditorView } from "@codemirror/view";
import type { BackendHost } from "../types";
import { resolveEditorLeaf, type NativeCM, type NativeInput } from "./native";

interface Replay {
  document: object;
  input?: NativeInput;
  action?: unknown;
}

/** A rendered table recreates native CM6 editors between cells. Keep only the
 * native edit recipe for that table, never modes, selections, marks, or adapters. */
export class NativeTableReplay {
  private tables = new WeakMap<HTMLElement, Replay>();
  private parents = new WeakMap<EditorView, Replay>();
  private seen = new WeakMap<NativeCM, Pick<Replay, "input" | "action">>();

  private scope(
    cm: NativeCM,
    host: BackendHost,
  ): { table?: HTMLElement; parent: EditorView; document: object } | undefined {
    const table = cm.cm6.dom.closest<HTMLElement>(".cm-table-widget");
    if (!host.settings().tables) return;
    const match = resolveEditorLeaf(host.app, cm.cm6);
    return match?.file
      ? { table: table ?? undefined, parent: match.parent, document: match.file }
      : undefined;
  }

  capture(cm: NativeCM, host: BackendHost): void {
    const scope = this.scope(cm, host);
    const state = cm.state.vim;
    if (!scope || !state || !state.lastEditInputState) return;
    const previous = this.seen.get(cm);
    if (
      previous?.input === state.lastEditInputState &&
      previous.action === state.lastEditActionCommand
    )
      return;
    const replay = {
      document: scope.document,
      input: state.lastEditInputState,
      action: state.lastEditActionCommand,
    };
    this.seen.set(cm, replay);
    if (scope.table) this.tables.set(scope.table, replay);
    this.parents.set(scope.parent, replay);
  }

  restore(cm: NativeCM, host: BackendHost, latest = false): void {
    const scope = this.scope(cm, host);
    const state = cm.state.vim;
    if (!scope || !state || (!latest && state.lastEditInputState)) return;
    const parent = this.parents.get(scope.parent);
    const replay = latest || !scope.table ? parent : (this.tables.get(scope.table) ?? parent);
    if (!replay || replay.document !== scope.document) return;
    state.lastEditInputState = replay.input;
    state.lastEditActionCommand = replay.action;
    this.seen.set(cm, replay);
  }

  clear(): void {
    this.tables = new WeakMap();
    this.parents = new WeakMap();
    this.seen = new WeakMap();
  }
}
