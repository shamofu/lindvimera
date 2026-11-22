import { Scope, type KeymapEventHandler } from "obsidian";
import type { BackendHost } from "../types";
import { getNativeCM, getNativeVim, iterateEditorLeaves, type NativeDocumentView } from "./native";

interface Guard {
  document: NativeDocumentView;
  scope: Scope;
  parent: Scope | null | undefined;
  handler: KeymapEventHandler;
}

/** Obsidian's application shortcuts run before CM6. Reserve only the logical
 * jump keys while a native Normal-mode editor owns focus. */
export class NativeNavigationScope {
  private guards = new Map<NativeDocumentView, Guard>();
  private disposed = false;

  constructor(private readonly host: BackendHost) {}

  refresh(): void {
    if (this.disposed) return;
    const current = new Set<NativeDocumentView>();
    if (this.host.isActive())
      iterateEditorLeaves(this.host.app, (document) => {
        current.add(document);
        const old = this.guards.get(document);
        if (old?.scope === document.scope) return;
        if (old) this.release(old);
        const parent = document.scope;
        const scope = new Scope(parent ?? this.host.app.scope);
        const handler = scope.register(null, null, (event) => {
          const ime = event.isComposing || event.key === "Process";
          if (
            this.disposed ||
            !this.host.isActive() ||
            !event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            event.shiftKey ||
            ime
          )
            return;
          const key = event.key.toLowerCase();
          if (key !== "o" && key !== "i") return;
          const owner = document.editMode;
          const view = owner?.tableCell?.cm ?? owner?.cm;
          if (
            !view ||
            view.composing ||
            !view.dom.contains(view.dom.ownerDocument.activeElement) ||
            owner?.editorSuggest?.isShowingSuggestion()
          )
            return;
          if (
            [
              ...view.dom.ownerDocument.querySelectorAll(".modal-container, .menu, .cm-dialog"),
            ].some((element) => element.getClientRects().length)
          )
            return;
          const cm = getNativeCM(view);
          const vim =
            view.dom.ownerDocument.defaultView && getNativeVim(view.dom.ownerDocument.defaultView);
          if (!cm?.state.vim || cm.state.vim.insertMode || cm.state.vim.visualMode || !vim) return;
          vim.handleKey(cm, `<C-${key}>`);
          event.preventDefault();
          return false;
        });
        this.guards.set(document, { document, scope, parent, handler });
        document.scope = scope;
      });
    for (const [document, guard] of this.guards) if (!current.has(document)) this.release(guard);
  }

  private release(guard: Guard): void {
    guard.scope.unregister(guard.handler);
    if (guard.document.scope === guard.scope) guard.document.scope = guard.parent;
    this.guards.delete(guard.document);
  }

  dispose(): void {
    this.disposed = true;
    for (const guard of this.guards.values()) this.release(guard);
  }
}
