import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView, runScopeHandlers, ViewPlugin } from "@codemirror/view";
import { Vim } from "@replit/codemirror-vim";
import { editorInfoField, MarkdownView, Scope, type KeymapEventHandler } from "obsidian";
import { analyseKeyBindings } from "../../input/policy";
import type { KeyBinding } from "../../settings";
import { editorSession, lindvimeraEditor } from "../../runtime/editor";
import { installMarkdownCommands } from "../../markdown";
import { installTableCommands } from "../../table/session";
import { internalRuntime } from "../../runtime/internal";
import type { BackendHost, EngineBackend } from "../types";

interface EditorOwner {
  cm?: EditorView;
  tableCell?: unknown;
  sourceMode?: boolean;
  editorSuggest?: { isShowingSuggestion(): boolean; close(): void };
}
function ownerOf(view: EditorView): EditorOwner | undefined {
  const info = view.state.field(editorInfoField, false) as unknown as
    | { editMode?: EditorOwner; editor?: EditorOwner }
    | undefined;
  return info?.editMode ?? info?.editor;
}

/** Bundled Vim owns these extensions, mappings, scopes, and transient sessions only. */
export function createBackend(host: BackendHost): EngineBackend {
  let alive = true;
  let bindings: KeyBinding[] = [];
  const editors = new Set<{ refresh(): void; flush(): void; disable(): void }>();
  const active = () => alive && host.isActive();
  const applyBindings = () => {
    for (const binding of bindings) Vim.unmap(binding.from, binding.mode);
    bindings = analyseKeyBindings(host.settings().keyBindings, host.settings()).active.map(
      (binding) => ({ ...binding }),
    );
    for (const binding of bindings) Vim.map(binding.from, binding.to, binding.mode);
  };
  installMarkdownCommands();
  installTableCommands();
  applyBindings();
  host.registerEditorExtension(
    ViewPlugin.define((view) => {
      const compartment = new Compartment();
      let mounted = true;
      let installed = false;
      let initialized = false;
      let scheduled = false;
      let guardedScope: Scope | null = null;
      let controlGuard: KeymapEventHandler | undefined;
      let guardedView: MarkdownView | undefined;
      let parentScope: Scope | null = null;
      const releaseScope = () => {
        if (guardedScope && controlGuard) guardedScope.unregister(controlGuard);
        if (guardedView?.scope === guardedScope) guardedView.scope = parentScope;
        guardedScope = null;
        guardedView = undefined;
        controlGuard = undefined;
      };
      const ensureScope = () => {
        if (!mounted || !installed || !active()) return;
        const info = view.state.field(editorInfoField, false);
        if (!(info instanceof MarkdownView)) return;
        if (guardedView === info && info.scope === guardedScope) return;
        releaseScope();
        guardedView = info;
        parentScope = info.scope;
        guardedScope = new Scope(parentScope ?? host.app.scope);
        controlGuard = guardedScope.register(null, null, (event) => {
          if (!active()) return;
          const result = editorSession(view)?.routeKey(event);
          return result === "handled" ? false : result === "ime" ? true : undefined;
        });
        info.scope = guardedScope;
      };
      const suggestion = () => ownerOf(view)?.editorSuggest;
      const cancelInputUI = () => {
        const current = suggestion();
        if (!current?.isShowingSuggestion()) return false;
        current.close();
        return true;
      };
      const instance = {
        flush() {
          editorSession(view)?.flush();
        },
        disable() {
          editorSession(view)?.finishInsert();
          releaseScope();
          if (installed) view.dispatch({ effects: compartment.reconfigure([]) });
          installed = false;
        },
        refresh() {
          if (scheduled || !mounted || !alive) return;
          scheduled = true;
          queueMicrotask(() => {
            scheduled = false;
            if (!mounted || !alive) return;
            const owner = ownerOf(view);
            if (!owner || owner.cm !== view) return;
            const enabled = active();
            if (!initialized) {
              initialized = true;
              view.dispatch({ effects: StateEffect.appendConfig.of(compartment.of([])) });
            }
            if (enabled === installed) {
              ensureScope();
              editorSession(view)?.configure();
              return;
            }
            instance.flush();
            if (!enabled) {
              editorSession(view)?.finishInsert();
              releaseScope();
            }
            installed = enabled;
            view.dispatch({
              effects: compartment.reconfigure(
                enabled
                  ? lindvimeraEditor({
                      settings: host.settings,
                      isActive: active,
                      wordSegmenter: host.wordSegmenter,
                      owner: () => ownerOf(view),
                      documentIdentity: () => view.state.field(editorInfoField, false)?.file,
                      inputUI: () => {
                        const overlays =
                          view.dom.ownerDocument.querySelectorAll(".modal-container, .menu");
                        if ([...overlays].some((element) => element.getClientRects().length))
                          return "blocked";
                        return suggestion()?.isShowingSuggestion() ? "suggestion" : "none";
                      },
                      cancelInputUI,
                      focusChanged: ensureScope,
                      modeChanged: (mode) => {
                        if (view.dom.contains(view.dom.ownerDocument.activeElement))
                          host.reportMode(mode);
                      },
                      error: host.reportError,
                      openLink: (linktext) => {
                        const info = view.state.field(editorInfoField, false);
                        if (info?.file)
                          void host.app.workspace.openLinkText(linktext, info.file.path, false);
                      },
                      markdownHost: {
                        smartLists: () =>
                          (
                            host.app.vault as unknown as { getConfig(key: string): unknown }
                          ).getConfig("smartIndentList") !== false,
                        livePreview: () => ownerOf(view)?.sourceMode === false,
                        enter: () =>
                          runScopeHandlers(
                            view,
                            new view.dom.ownerDocument.defaultView!.KeyboardEvent("keydown", {
                              key: "Enter",
                              bubbles: true,
                              cancelable: true,
                            }),
                            "editor",
                          ),
                        indent: (more) => {
                          const editor = view.state.field(editorInfoField, false)?.editor;
                          if (!editor) return false;
                          editor.exec(more ? "indentMore" : "indentLess");
                          return true;
                        },
                      },
                    })
                  : [],
              ),
            });
            ensureScope();
          });
        },
        destroy() {
          mounted = false;
          releaseScope();
          editors.delete(instance);
        },
      };
      editors.add(instance);
      instance.refresh();
      return instance;
    }),
  );
  return {
    runtime: internalRuntime,
    refresh() {
      for (const editor of editors) editor.refresh();
    },
    flush() {
      for (const editor of editors) editor.flush();
    },
    applySettings(appearanceOnly = false) {
      if (!appearanceOnly) {
        for (const editor of editors) editor.flush();
        applyBindings();
      }
      for (const editor of editors) editor.refresh();
    },
    dispose() {
      if (!alive) return;
      alive = false;
      for (const editor of editors) editor.disable();
      editors.clear();
      for (const binding of bindings) Vim.unmap(binding.from, binding.mode);
      bindings = [];
    },
  };
}
