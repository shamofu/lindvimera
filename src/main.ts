import { Notice, Plugin, type App, type Events } from "obsidian";
import { DEFAULT_SETTINGS, loadSettings, type LindvimeraSettings } from "./settings";
import { LindvimeraSettingTab } from "./settings-tab";
import { openCommandGuide } from "./ui/guide";
import { budouxSegmenter, type JapaneseSegmenter } from "./word";
import { JapaneseWordService, type LinderaMode } from "./word/service";
import embeddedAssets from "lindvimera:assets";
import { createBundledAssetReader } from "./word/asset-reader";
import { EngineController } from "./engines/controller";
import { defaultEngine, engineRegistry, getEngine } from "./engines/registry";
import { resolveEngineSelection, type EngineId } from "./engines/selection";
import { createRuntimeFacade, type RuntimeFacade } from "./engines/runtime";

interface HostConfig {
  getConfig(key: string): unknown;
  setConfig(key: string, value: unknown): void;
}

export default class LindvimeraPlugin extends Plugin {
  runtime!: RuntimeFacade;
  settings: LindvimeraSettings = loadSettings(DEFAULT_SETTINGS);
  private engine?: EngineController;
  private status?: HTMLElement;
  private mode = "";
  private notifiedConflict = false;
  private words?: JapaneseWordService;
  wordsReady: Promise<void> = Promise.resolve();

  wordSegmenter(mode: LinderaMode = this.settings.linderaMode): JapaneseSegmenter {
    return this.words?.segmenter(mode) ?? budouxSegmenter;
  }

  builtinVim(): boolean {
    return (
      (this.app as App & { isVimEnabled?(): boolean }).isVimEnabled?.() ??
      (this.app.vault as unknown as HostConfig).getConfig("vimMode") === true
    );
  }

  activeEngine(): EngineId {
    return this.engine?.id ?? defaultEngine;
  }

  engineConflict(): boolean {
    return this.builtinVim() !== getEngine(this.activeEngine()).nativeVim;
  }

  engineNeedsReload(): boolean {
    return (
      (this.settings.engine ?? defaultEngine) !== this.activeEngine() ||
      (this.settings.engine !== undefined && this.engineConflict())
    );
  }

  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    const available = engineRegistry.map(({ id }) => id);
    const selection = resolveEngineSelection(this.settings.engine, available, defaultEngine);
    if (selection.migratedFrom) {
      this.settings.engine = selection.id;
      await this.saveData(this.settings);
      new Notice(
        `Lindvimera: 以前のエンジンは提供を終了したため、${getEngine(selection.id).label}へ移行しました。設定とキー割り当ては保持しています。`,
        10000,
      );
    }
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
    this.status = this.addStatusBarItem();
    this.engine = new EngineController(getEngine(selection.id), {
      app: this.app,
      settings: () => this.settings,
      wordSegmenter: () => this.wordSegmenter(),
      nativeVim: () => this.builtinVim(),
      setNativeVim: (enabled) => {
        const vault = this.app.vault as unknown as HostConfig;
        if (typeof vault.setConfig !== "function")
          throw new Error("ObsidianのVim設定を同期できません。1.15以降が必要です。");
        vault.setConfig("vimMode", enabled);
      },
      registerEditorExtension: (extension) => this.registerEditorExtension(extension),
      reportMode: (mode) => {
        this.mode = mode;
        this.showMode();
      },
      reportError: (message) => {
        new Notice(`Lindvimera: ${message}`, 10000);
        this.showMode();
      },
    });
    this.runtime = createRuntimeFacade(
      this.engine,
      () => this.settings.engine ?? defaultEngine,
      available,
    );
    this.addSettingTab(new LindvimeraSettingTab(this.app, this));
    this.registerEvent(
      (this.app.vault as unknown as Events).on("config-changed", (key: unknown) => {
        if (key === "vimMode" || key === "smartIndentList") this.refreshEditors();
      }),
    );
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshEditors()));
    this.addCommand({
      id: "open-guide",
      name: "操作ガイド",
      callback: () => openCommandGuide(this.app, () => this.settings),
    });
    this.addCommand({
      id: "toggle-enabled",
      name: "Toggle enabled",
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        void this.saveSettings();
      },
    });
    await this.engine.start();
    this.refreshEditors();
    if (this.settings.japanese) this.wordsReady = this.words.load();
  }

  private showMode(): void {
    if (!this.status) return;
    if (!this.settings.showStatus || !this.settings.enabled) {
      this.status.textContent = "";
      return;
    }
    const status = this.engine?.status;
    const text =
      status === "failed"
        ? "起動失敗"
        : status === "suspended"
          ? "停止中（Vim設定を確認）"
          : this.mode;
    this.status.textContent = `Lindvimera ${text}${this.engineNeedsReload() ? " · 再読み込み待ち" : ""}`;
  }

  private refreshEditors(): void {
    this.engine?.refresh();
    const conflict = this.settings.enabled && this.engineConflict();
    if (conflict && !this.notifiedConflict)
      new Notice(
        this.settings.engine === undefined
          ? "Lindvimera: ObsidianのVim設定が既定のエンジンと異なるため停止しています。エンジンを明示的に選択して再読み込みしてください。"
          : "Lindvimera: ObsidianのVim設定が選択したエンジンと異なるため、追加の入力処理を停止しました。プラグインを再読み込みすると選択を反映します。",
        10000,
      );
    this.notifiedConflict = conflict;
    this.showMode();
  }

  /** Persist a pending choice without flushing, rebinding or changing host Vim. */
  async selectEngine(id: EngineId): Promise<void> {
    getEngine(id);
    const previous = this.settings.engine;
    this.settings.engine = id;
    try {
      await this.saveData(this.settings);
    } catch (error) {
      if (previous === undefined) delete this.settings.engine;
      else this.settings.engine = previous;
      throw error;
    }
    this.showMode();
  }

  async saveSettings(appearanceOnly = false): Promise<void> {
    this.engine?.applySettings(appearanceOnly);
    if (this.settings.japanese && this.words) this.wordsReady = this.words.load();
    await this.saveData(this.settings);
    this.refreshEditors();
  }

  onunload(): void {
    this.engine?.dispose();
    this.words?.dispose();
  }
}
