import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { Vim } from "@replit/codemirror-vim";
import {
  editorInfoField,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  Scope,
  type App,
  type Events,
  type KeymapEventHandler,
} from "obsidian";
import { checkedEscapeSettings } from "./input/escape";
import { analyseKeyBindings } from "./input/policy";
import {
  checkedKeyBindings,
  DEFAULT_SETTINGS,
  loadSettings,
  type KeyBinding,
  type LindvimeraSettings,
} from "./settings";
import { editorSession, lindvimeraEditor } from "./runtime/editor";
import { installMarkdownCommands } from "./markdown";
import { installTableCommands } from "./table/session";
import { ProbeView, PROBE_VIEW_TYPE } from "./probe/view";
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
      name: "Toggle Lindvimera",
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        void this.saveSettings();
      },
    });
    if (this.settings.probeEnabled) {
      const observedKeys: unknown[] = [];
      let diagnosticWrite = Promise.resolve();
      this.registerDomEvent(
        document,
        "keydown",
        (event) => {
          observedKeys.push({
            key: event.key,
            code: event.code,
            trusted: event.isTrusted,
            composing: event.isComposing,
            target: (event.target as HTMLElement)?.className,
            focus: document.activeElement?.className,
          });
          if (observedKeys.length > 30) observedKeys.shift();
          const snapshot = JSON.stringify(observedKeys, null, 2);
          diagnosticWrite = diagnosticWrite.then(() =>
            this.app.vault.adapter.write("Lindvimera input diagnostics.json", snapshot),
          );
        },
        true,
      );
      this.registerView(PROBE_VIEW_TYPE, (leaf) => new ProbeView(leaf, this));
      this.addCommand({
        id: "open-input-probe",
        name: "Open regression workbench",
        callback: () => void this.openProbe(),
      });
      const runNative = () => {
        const probe = this.app.workspace.getLeavesOfType(PROBE_VIEW_TYPE)[0]?.view;
        if (probe instanceof ProbeView) void probe.runNativeRegression();
      };
      this.addCommand({
        id: "run-native-regression",
        name: "Run native table regression",
        callback: runNative,
      });
      this.addRibbonIcon("table", "Lindvimera: run native table regression", runNative);
      this.app.workspace.onLayoutReady(() => void this.openProbe());
    }
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

  async openProbe(): Promise<void> {
    if (!this.settings.probeEnabled) return;
    const leaf =
      this.app.workspace.getLeavesOfType(PROBE_VIEW_TYPE)[0] ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: PROBE_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}

class LindvimeraSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: LindvimeraPlugin,
  ) {
    super(app, plugin);
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Lindvimera" });
    if (this.plugin.builtinVim())
      containerEl.createEl("p", {
        text: "組み込みVimが有効です。エディタ設定の「Vimキー割り当て」を無効にするとLindvimeraが動作します。",
      });
    const toggles = {
      enabled: "Lindvimeraを有効にする",
      japanese: "日本語の単語操作",
      markdownMotions: "見出し・リスト移動",
      textObjects: "Markdownテキストオブジェクト",
      surround: "Surround",
      tables: "Live Previewテーブル連携",
      showStatus: "ステータスバーにモードを表示",
    } as const;
    for (const [key, name] of Object.entries(toggles)) {
      const flag = key as keyof typeof toggles;
      new Setting(containerEl).setName(name).addToggle((toggle) =>
        toggle.setValue(this.plugin.settings[flag]).onChange(async (value) => {
          this.plugin.settings[flag] = value;
          await this.plugin.saveSettings(flag === "japanese");
          if (flag === "japanese") this.display();
        }),
      );
      if (flag === "japanese") {
        new Setting(containerEl)
          .setName("日本語の分割モード")
          .setDesc(
            "標準：辞書にある複合語を保持（関西国際空港）。詳細：複合語をさらに分割（関西 / 国際 / 空港）。変更は進行中のコマンド・マクロの完了後に反映します。",
          )
          .addDropdown((dropdown) =>
            dropdown
              .addOption("normal", "標準：辞書にある複合語を保持")
              .addOption("decompose", "詳細：複合語をさらに分割")
              .setValue(this.plugin.settings.linderaMode)
              .setDisabled(!this.plugin.settings.japanese)
              .onChange(async (value) => {
                this.plugin.settings.linderaMode = value === "decompose" ? "decompose" : "normal";
                await this.plugin.saveSettings(true);
              }),
          );
      }
    }
    const error = containerEl.createEl("p", { cls: "lindvimera-setting-error" });
    new Setting(containerEl)
      .setName("挿入モードの脱出キー")
      .setDesc('JSON配列。例: ["jj", "jk"]。[]で無効。')
      .addTextArea((input) =>
        input
          .setValue(JSON.stringify(this.plugin.settings.escapeSequences))
          .onChange(async (value) => {
            try {
              const parsed: unknown = JSON.parse(value);
              if (!Array.isArray(parsed) || !parsed.every((key) => typeof key === "string"))
                throw new Error("文字列の配列を指定してください。");
              const checked = checkedEscapeSettings({
                sequences: parsed,
                timeoutMs: this.plugin.settings.escapeTimeoutMs,
              });
              this.plugin.settings.escapeSequences = [...checked.sequences];
              error.textContent = "";
              await this.plugin.saveSettings();
            } catch (reason) {
              error.textContent = String(reason);
            }
          }),
      );
    new Setting(containerEl).setName("脱出キーの判定時間（ms）").addText((input) =>
      input.setValue(String(this.plugin.settings.escapeTimeoutMs)).onChange(async (value) => {
        try {
          const checked = checkedEscapeSettings({
            sequences: this.plugin.settings.escapeSequences,
            timeoutMs: Number(value),
          });
          this.plugin.settings.escapeTimeoutMs = checked.timeoutMs;
          error.textContent = "";
          await this.plugin.saveSettings();
        } catch (reason) {
          error.textContent = String(reason);
        }
      }),
    );
    const bindingIssues = containerEl.createEl("p", { cls: "lindvimera-setting-error" });
    const showBindingIssues = () => {
      bindingIssues.textContent = analyseKeyBindings(this.plugin.settings.keyBindings)
        .issues.map(
          ({ binding, reason }) => `${binding.mode}: ${binding.from} → ${binding.to} — ${reason}`,
        )
        .join("\n");
    };
    showBindingIssues();
    new Setting(containerEl)
      .setName("モード別キー割り当て")
      .setDesc(
        'JSON配列。例: [{"mode":"normal","from":"H","to":"^"}]。mode: normal / insert / visual / operatorPending。未対応の操作を含む割り当ては保存したまま無効にします。',
      )
      .addTextArea((input) =>
        input
          .setValue(JSON.stringify(this.plugin.settings.keyBindings, null, 2))
          .onChange(async (value) => {
            try {
              this.plugin.settings.keyBindings = checkedKeyBindings(JSON.parse(value));
              error.textContent = "";
              await this.plugin.saveSettings();
              showBindingIssues();
            } catch (reason) {
              error.textContent = String(reason);
            }
          }),
      );
    if (this.plugin.settings.probeEnabled)
      new Setting(containerEl)
        .setName("回帰テスト")
        .addButton((button) =>
          button.setButtonText("開く").onClick(() => void this.plugin.openProbe()),
        );
  }
}
