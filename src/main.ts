import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { Vim } from "@replit/codemirror-vim";
import {
  editorInfoField,
  MarkdownView,
  Notice,
  Plugin,
  Scope,
  type App,
  type Events,
  type KeymapEventHandler,
} from "obsidian";
import { analyseKeyBindings } from "./input/policy";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type KeyBinding,
  type LindvimeraSettings,
} from "./settings";
import { editorSession, lindvimeraEditor } from "./runtime/editor";
import { installMarkdownCommands } from "./markdown";
import { installTableCommands } from "./table/session";
import { LindvimeraSettingTab } from "./settings-tab";
import { internalRuntime } from "./runtime/internal";
import { budouxSegmenter, type JapaneseSegmenter } from "./word";
import { JapaneseWordService, type LinderaMode } from "./word/service";
import embeddedAssets from "lindvimera:assets";
import { createBundledAssetReader } from "./word/asset-reader";

interface EditorOwner {
  cm?: EditorView;
  tableCell?: unknown;
  editorSuggest?: { isShowingSuggestion(): boolean; close(): void };
}
function ownerOf(view: EditorView): EditorOwner | undefined {
  const info = view.state.field(editorInfoField, false) as unknown as
    | {
        editMode?: EditorOwner;
        editor?: { cm?: EditorView };
      }
    | undefined;
  return info?.editMode ?? info?.editor;
}

export default class LindvimeraPlugin extends Plugin {
  readonly runtime = internalRuntime;
  settings: LindvimeraSettings = { ...DEFAULT_SETTINGS };
  private editors = new Set<{ refresh(): void; flush(): void; disable(): void }>();
  private bindings: KeyBinding[] = [];
  private status?: HTMLElement;
  private notified = false;
  private words?: JapaneseWordService;
  wordsReady: Promise<void> = Promise.resolve();

  wordSegmenter(mode: LinderaMode = this.settings.linderaMode): JapaneseSegmenter {
    return this.words?.segmenter(mode) ?? budouxSegmenter;
  }

  builtinVim(): boolean {
    return (this.app as App & { isVimEnabled?(): boolean }).isVimEnabled?.() ?? false;
  }

  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    this.words = new JapaneseWordService(
      createBundledAssetReader(embeddedAssets),
      () => this.refreshEditors(),
      (error) => {
        console.warn("Lindvimera: Lindera initialization or analysis failed.", error);
        new Notice(
          "Lindvimera: 日本語辞書を読み込めませんでした。BudouXで操作を続けます。プラグインを再インストールしてください。",
          10000,
        );
      },
    );
    installMarkdownCommands();
    installTableCommands();
    this.applyBindings();
    this.status = this.addStatusBarItem();
    this.addSettingTab(new LindvimeraSettingTab(this.app, this));

    this.registerEditorExtension(
      ViewPlugin.define((view) => {
        const compartment = new Compartment();
        let alive = true;
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
          if (!alive || !installed) return;
          const info = view.state.field(editorInfoField, false);
          if (!(info instanceof MarkdownView)) return;
          if (guardedView === info && info.scope === guardedScope) return;
          releaseScope();
          guardedView = info;
          parentScope = info.scope;
          // An appended callback loses to the host's existing Escape handler.
          // A child scope decides editor keys before delegating to the host.
          guardedScope = new Scope(parentScope ?? this.app.scope);
          controlGuard = guardedScope.register(null, null, (event) => {
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
          refresh: () => {
            if (scheduled || !alive) return;
            scheduled = true;
            queueMicrotask(() => {
              scheduled = false;
              if (!alive) return;
              const owner = ownerOf(view);
              // Native cells also receive workspace extensions. Only the parent owns Vim.
              if (!owner || owner.cm !== view) return;
              const enabled = this.settings.enabled && !this.builtinVim();
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
                        settings: () => this.settings,
                        wordSegmenter: () => this.wordSegmenter(),
                        owner: () => ownerOf(view),
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
                          if (
                            view.dom.contains(view.dom.ownerDocument.activeElement) ||
                            !this.status?.textContent
                          )
                            this.showMode(mode);
                        },
                        error: (message) => new Notice(`Lindvimera: ${message}`),
                        openLink: (linktext) => {
                          const info = view.state.field(editorInfoField, false);
                          if (info?.file)
                            void this.app.workspace.openLinkText(linktext, info.file.path, false);
                        },
                      })
                    : [],
                ),
              });
              ensureScope();
            });
          },
          destroy: () => {
            alive = false;
            releaseScope();
            this.editors.delete(instance);
          },
        };
        this.editors.add(instance);
        instance.refresh();
        return instance;
      }),
    );
    this.registerEvent(
      (this.app.vault as unknown as Events).on("config-changed", (key: unknown) => {
        if (key === "vimMode") this.refreshEditors();
      }),
    );
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshEditors()));
    this.addCommand({
      id: "toggle-enabled",
      name: "Toggle enabled",
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        void this.saveSettings();
      },
    });
    this.refreshEditors();
    if (this.settings.japanese) this.wordsReady = this.words.load();
  }

  private showMode(mode: string): void {
    if (this.status)
      this.status.textContent =
        this.settings.showStatus && this.settings.enabled && !this.builtinVim()
          ? `Lindvimera ${mode}`
          : "";
  }

  private refreshEditors(): void {
    if (this.builtinVim() && this.settings.enabled && !this.notified) {
      this.notified = true;
      new Notice(
        "Lindvimera: 設定 → エディタ → Vimキー割り当てを無効にしてください。組み込みVimが有効な間、Lindvimeraは停止します。",
        10000,
      );
    }
    if (!this.builtinVim()) this.notified = false;
    for (const editor of this.editors) editor.refresh();
    if (!this.settings.enabled || this.builtinVim() || !this.settings.showStatus) this.showMode("");
  }

  private applyBindings(): void {
    for (const binding of this.bindings) Vim.unmap(binding.from, binding.mode);
    this.bindings = analyseKeyBindings(this.settings.keyBindings).active.map((binding) => ({
      ...binding,
    }));
    for (const binding of this.bindings) Vim.map(binding.from, binding.to, binding.mode);
  }

  async saveSettings(wordsOnly = false): Promise<void> {
    if (!wordsOnly) {
      for (const editor of this.editors) editor.flush();
      this.applyBindings();
    }
    if (this.settings.japanese && this.words) this.wordsReady = this.words.load();
    await this.saveData(this.settings);
    this.refreshEditors();
  }

  onunload(): void {
    for (const editor of this.editors) editor.disable();
    this.words?.dispose();
    for (const binding of this.bindings) Vim.unmap(binding.from, binding.mode);
  }
}
