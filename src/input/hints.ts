import { Vim, type CodeMirror } from "@replit/codemirror-vim";
import type { EditorView } from "@codemirror/view";
import type { LindvimeraSettings } from "../settings";
import { commandDescription } from "./catalog";
import { child } from "../ui/dom";

interface Candidate {
  keys: string;
  name: string;
  type: string;
  toKeys?: string;
}
interface CandidateAPI {
  getPendingCommands(cm: CodeMirror, literalKeys: readonly string[]): Candidate[];
}
const objectKeys = [..."wWspbB()[]{}<>\"'`"].flatMap((key) => ["i" + key, "a" + key]);

/** The engine returns detached descriptors, never a command that this UI can execute. */
export function pendingHintEntries(cm: CodeMirror): { key: string; label: string }[] {
  const state = cm.state.vim;
  if (!state || state.insertMode || cm.state.dialog) return [];
  const input = state.inputState;
  const prefix = input.keyBuffer.join("").replace(/^[1-9]\d*/, "");
  const api = Vim as typeof Vim & CandidateAPI;
  const candidates = api
    .getPendingCommands(cm, objectKeys)
    .filter(
      (candidate) =>
        cm.getEditingView() === cm.cm6 ||
        !(
          candidate.name.startsWith("lindvimeraFold") ||
          /^lindvimeraObject[hL]$/.test(candidate.name)
        ),
    );
  if (state.expectLiteralNext) {
    const surround = candidates.some((candidate) =>
      candidate.name.startsWith("lindvimeraSurround"),
    );
    return [
      {
        key: "次の1文字",
        label: surround ? "囲み文字を入力（例: )、'、*）" : "検索・置換する文字を入力",
      },
    ];
  }
  const registerHint = /^(?:m|'|`|"|q|@)$/.test(prefix)
    ? [
        {
          key: prefix === "m" || prefix === "'" || prefix === "`" ? "a〜z" : "レジスタ",
          label: "使用する名前を入力",
        },
      ]
    : [];
  if (
    candidates.some(
      (candidate) =>
        candidate.keys === "<character>" && candidate.name.startsWith("lindvimeraSurround"),
    )
  )
    return [{ key: "次の1文字", label: "対象の囲み文字を入力（例: )、'、*）" }];
  return [
    ...candidates
      .filter(
        (candidate) =>
          !/<(?:character|register)>$/.test(candidate.keys) ||
          (!registerHint.length && candidate.keys !== "<character>"),
      )
      .map((candidate) => ({
        key: candidate.keys.slice(prefix.length) || candidate.keys,
        label: candidate.toKeys
          ? `割り当て → ${candidate.toKeys}`
          : candidate.name.startsWith("lindvimeraSurround")
            ? "囲みの追加・削除・変更"
            : commandDescription(
                candidate.keys,
                state.visualMode ? "visual" : input.operator ? "operatorPending" : "normal",
              ).label,
      })),
    ...registerHint,
  ];
}

interface HintHost {
  settings(): LindvimeraSettings;
  target(): EditorView;
  blocked(): boolean;
}

/** A passive overlay: it never receives focus, keystrokes, or editor transactions. */
export class PendingHints {
  private timer?: number;
  private overlay?: HTMLElement;
  private generation = 0;
  private disposed = false;
  private timerWindow: Window;

  constructor(
    private cm: CodeMirror,
    private host: HintHost,
  ) {
    this.timerWindow = cm.cm6.dom.ownerDocument.defaultView ?? window;
  }

  private eligible(): boolean {
    const target = this.host.target();
    const state = this.cm.state.vim;
    const macro = Vim.getVimGlobalState_().macroModeState;
    const settings = this.host.settings();
    return (
      !this.disposed &&
      settings.enabled &&
      settings.showPendingHints &&
      !!state &&
      !state.insertMode &&
      !this.cm.state.overwrite &&
      !this.cm.state.dialog &&
      !target.composing &&
      target.contentDOM.contains(target.dom.ownerDocument.activeElement) &&
      !macro.isPlaying &&
      !macro.isRecording &&
      !this.host.blocked()
    );
  }

  hide(): void {
    this.generation++;
    if (this.timer !== undefined) this.timerWindow.clearTimeout(this.timer);
    this.timer = undefined;
    this.overlay?.remove();
    this.overlay = undefined;
  }

  refresh(): void {
    this.hide();
    if (!this.eligible()) return;
    const input = this.cm.state.vim!.inputState;
    if (
      !input.operator &&
      !this.cm.state.vim!.expectLiteralNext &&
      !input.keyBuffer.join("").replace(/^[1-9]\d*/, "")
    )
      return;
    const generation = this.generation;
    const target = this.host.target();
    this.timer = this.timerWindow.setTimeout(() => {
      this.timer = undefined;
      if (generation !== this.generation || target !== this.host.target() || !this.eligible())
        return;
      const entries = pendingHintEntries(this.cm);
      if (!entries.length) return;
      const root = this.cm.cm6.dom;
      const overlay = child(root, "div", "lindvimera-pending-hints");
      overlay.setAttribute("role", "note");
      overlay.setAttribute("aria-label", "続けて使えるVimキー");
      const title = child(overlay, "div");
      title.className = "lindvimera-hint-title";
      title.textContent = "続けて使えるキー";
      for (const entry of entries.slice(0, 8)) {
        const row = child(overlay, "div");
        const key = child(row, "kbd");
        key.textContent = entry.key;
        const label = child(row, "span");
        label.textContent = entry.label;
      }
      if (entries.length > 8) {
        const remaining = child(overlay, "div");
        remaining.textContent = `ほか${entries.length - 8}件 · 続く入力で絞り込み`;
      }
      this.overlay = overlay;
    }, 500);
  }

  destroy(): void {
    this.disposed = true;
    this.hide();
  }
}
