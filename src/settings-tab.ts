import {
  PluginSettingTab,
  type App,
  type ButtonComponent,
  type ColorComponent,
  type Plugin,
  type Setting,
  type SettingDefinitionItem,
} from "obsidian";
import { checkedEscapeSettings } from "./input/escape";
import { checkedCursorColor, type LindvimeraSettings } from "./settings";
import { child } from "./ui/dom";
import { checkedMappingDraft, renderMappingEditor } from "./ui/mapping-editor";
import { openCommandGuide } from "./ui/guide";
import { defaultEngine, engineRegistry } from "./engines/registry";
import type { EngineId } from "./engines/selection";

interface SettingsHost extends Plugin {
  settings: LindvimeraSettings;
  builtinVim(): boolean;
  engineConflict(): boolean;
  engineNeedsReload(): boolean;
  selectEngine(id: EngineId): Promise<void>;
  saveSettings(wordsOnly?: boolean): Promise<void>;
}

const toggles = {
  enabled: "Lindvimeraを有効にする",
  japanese: "日本語の単語・文操作",
  markdownMotions: "見出し・リスト移動",
  markdownEditing: "Markdownに合わせた行追加・行頭操作",
  textObjects: "Markdownテキストオブジェクト",
  surround: "Surround",
  tables: "Live Previewテーブル連携",
  folding: "Vimキーで折り畳みを操作",
  showStatus: "ステータスバーにモードを表示",
  showPendingHints: "入力待ちのキー候補を表示",
} as const;

/** Uses the host's searchable controls while keeping the persisted settings schema. */
export class LindvimeraSettingTab extends PluginSettingTab {
  private refreshMappings?: () => void;
  private refreshCursor?: () => void;

  constructor(
    app: App,
    private readonly host: SettingsHost,
  ) {
    super(app, host);
  }

  override getControlValue(key: string): unknown {
    const settings = this.host.settings;
    if (key === "engine") return settings.engine ?? defaultEngine;
    if (key === "escapeSequences") return JSON.stringify(settings.escapeSequences);
    if (key === "keyBindings") return JSON.stringify(settings.keyBindings, null, 2);
    if (key === "escapeTimeoutMs") return String(settings.escapeTimeoutMs);
    return Object.hasOwn(settings, key) ? settings[key as keyof LindvimeraSettings] : undefined;
  }

  private checkedValue(key: string, value: unknown): unknown {
    const settings = this.host.settings;
    if (key === "engine") {
      if (!engineRegistry.some(({ id }) => id === value))
        throw new Error("利用できないエンジンです。");
      return value;
    }
    if (key === "cursorColor") return checkedCursorColor(value);
    if (Object.hasOwn(toggles, key)) {
      if (typeof value !== "boolean") throw new Error("オン・オフを指定してください。");
      return value;
    }
    if (key === "linderaMode") {
      if (value !== "normal" && value !== "decompose") throw new Error("分割モードが不正です。");
      return value;
    }
    if (typeof value !== "string") throw new Error("文字列を指定してください。");
    if (key === "keyBindings") return checkedMappingDraft(JSON.parse(value), settings);
    if (key === "escapeSequences") {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || !parsed.every((item: unknown) => typeof item === "string"))
        throw new Error("文字列の配列を指定してください。");
      return [
        ...checkedEscapeSettings({ sequences: parsed, timeoutMs: settings.escapeTimeoutMs })
          .sequences,
      ];
    }
    if (key === "escapeTimeoutMs")
      return checkedEscapeSettings({
        sequences: settings.escapeSequences,
        timeoutMs: Number(value),
      }).timeoutMs;
    throw new Error("不明な設定です。");
  }

  private validate(key: string, value: string): string | void {
    try {
      this.checkedValue(key, value);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const checked = this.checkedValue(key, value);
    if (key === "engine") {
      await this.host.selectEngine(checked as EngineId);
      this.refreshDomState();
      this.refreshMappings?.();
      return;
    }
    const settings = this.host.settings;
    const previousBindings = settings.keyBindings;
    const previousCursorColor = settings.cursorColor;
    if (Object.hasOwn(toggles, key)) settings[key as keyof typeof toggles] = checked as boolean;
    else if (key === "linderaMode")
      settings.linderaMode = checked as LindvimeraSettings["linderaMode"];
    else if (key === "escapeSequences") settings.escapeSequences = checked as string[];
    else if (key === "escapeTimeoutMs") settings.escapeTimeoutMs = checked as number;
    else if (key === "keyBindings")
      settings.keyBindings = checked as LindvimeraSettings["keyBindings"];
    else if (key === "cursorColor") settings.cursorColor = checked as string | null;
    try {
      // Cursor appearance needs a live refresh without flushing pending input.
      await this.host.saveSettings(
        key === "japanese" || key === "linderaMode" || key === "cursorColor",
      );
    } catch (error) {
      if (key === "keyBindings") {
        settings.keyBindings = previousBindings;
        // saveSettings applies runtime mappings before persisting. Restore both
        // the runtime and saved data, retaining the original failure for the form.
        await this.host.saveSettings(false).catch(() => {});
      }
      if (key === "cursorColor") {
        settings.cursorColor = previousCursorColor;
        await this.host.saveSettings(true).catch(() => {});
        this.refreshCursor?.();
      }
      throw error;
    }
    // Preserve in-progress text in other controls when dependent state changes.
    this.refreshDomState();
    this.refreshMappings?.();
    this.refreshCursor?.();
  }

  private renderCursorColor(setting: Setting): void {
    let picker: ColorComponent;
    let reset: ButtonComponent;
    let busy = false;
    const error = child(setting.controlEl, "div", "lindvimera-setting-error");
    error.setAttribute("role", "status");
    const refresh = () => {
      const color = this.host.settings.cursorColor;
      picker.setValue(color ?? "#ff9696").setDisabled(busy);
      reset.setDisabled(busy || color === null);
      setting.setDesc(
        color === null
          ? "既存の色を使用中です。色見本は既定のブロックカーソルの色です。"
          : "Normal・Insert・Visual・Replaceと、Live Previewのテーブル内に共通の色を使用します。",
      );
    };
    const save = async (color: string | null) => {
      if (busy) return;
      busy = true;
      error.textContent = "";
      refresh();
      try {
        await this.setControlValue("cursorColor", color);
      } catch (reason) {
        error.textContent = reason instanceof Error ? reason.message : String(reason);
      } finally {
        busy = false;
        refresh();
      }
    };
    setting.addColorPicker((component) => {
      picker = component;
      component.onChange((value) => void save(value));
    });
    setting.addButton((component) => {
      reset = component;
      component.setButtonText("既定に戻す").onClick(() => void save(null));
    });
    this.refreshCursor = refresh;
    refresh();
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const definitions: SettingDefinitionItem[] = [
      {
        name: "Vim設定が選択と異なります",
        desc: "追加の入力処理を停止しています。エンジンを明示的に選択して再読み込みするとObsidianのVim設定を同期します。旧設定のまま使う場合は、ObsidianのVimキー割り当てを無効にしてください。",
        visible: () => this.host.engineConflict(),
      },
      {
        name: "Vimエンジン",
        desc: "変更はプラグインの再読み込み後に反映します。組み込みVimは実験的です。モード・レジスタ・マクロなどの作業中の状態は引き継ぎません。",
        visible: () => engineRegistry.length > 1,
        control: {
          type: "dropdown",
          key: "engine",
          options: Object.fromEntries(engineRegistry.map(({ id, label }) => [id, label])),
        },
      },
      {
        name: "エンジンの変更を保存しました",
        desc: "反映するには、コミュニティプラグインの一覧でLindvimeraを無効にしてから再度有効にしてください。",
        visible: () => this.host.engineNeedsReload(),
      },
    ];
    for (const [key, name] of Object.entries(toggles)) {
      definitions.push({ name, control: { type: "toggle", key } });
      if (key === "japanese")
        definitions.push({
          name: "日本語の分割モード",
          desc: "標準：辞書にある複合語を保持（関西国際空港）。詳細：複合語をさらに分割（関西 / 国際 / 空港）。変更は進行中のコマンド・マクロの完了後に反映します。",
          control: {
            type: "dropdown",
            key: "linderaMode",
            options: {
              normal: "標準：辞書にある複合語を保持",
              decompose: "詳細：複合語をさらに分割",
            },
            disabled: () => !this.host.settings.japanese,
          },
        });
    }
    definitions.push(
      {
        name: "カーソルの色",
        desc: "Normal・Insert・Visual・Replaceと、Live Previewのテーブル内に共通の色を設定します。未設定時は既存の色を使用します。",
        render: (setting) => this.renderCursorColor(setting),
      },
      {
        name: "挿入モードの脱出キー",
        desc: 'JSON配列。例: ["jj", "jk"]。[]で無効。',
        control: {
          type: "textarea",
          key: "escapeSequences",
          validate: (value) => this.validate("escapeSequences", value),
        },
      },
      {
        name: "脱出キーの判定時間（ms）",
        control: {
          type: "text",
          key: "escapeTimeoutMs",
          validate: (value) => this.validate("escapeTimeoutMs", value),
        },
      },
      {
        name: "モード別キー割り当て",
        desc: "モード・入力キー・実行キー列を指定します。未対応の操作を含む割り当ては保存したまま無効にします。",
        render: (setting) => {
          setting.settingEl.classList.add("lindvimera-mapping-setting");
          this.refreshMappings = renderMappingEditor(setting.controlEl, {
            getBindings: () => this.host.settings.keyBindings,
            getSettings: () => this.host.settings,
            save: (bindings) => this.setControlValue("keyBindings", JSON.stringify(bindings)),
          });
        },
      },
      {
        name: "操作ガイド",
        desc: "対応するVim操作とキー割り当てを、キー・操作名・モード・分類から探せます。",
        render: (setting) => {
          setting.addButton((button) =>
            button
              .setButtonText("操作ガイドを開く")
              .onClick(() => openCommandGuide(this.app, () => this.host.settings)),
          );
        },
      },
    );
    return definitions;
  }
}
