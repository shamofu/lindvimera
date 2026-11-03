import { getGuideEntries } from "../../input/catalog";
import type { LindvimeraSettings, VimMode } from "../../settings";
import { child } from "../../ui/dom";
import type { BackendHost } from "../types";
import type { NativeCM, NativeState, NativeVim } from "./native";

interface Hint {
  key: string;
  label: string;
}

/** Read native input state only. Never call findKey/handleKey to discover candidates. */
export function nativeHintEntries(state: NativeState, settings: LindvimeraSettings): Hint[] {
  if (state.insertMode) return [];
  if (state.expectLiteralNext) return [{ key: "次の1文字", label: "対象の文字・囲み・名前を入力" }];
  const prefix = state.inputState.keyBuffer.join("").replace(/^[1-9]\d*/u, "");
  if (!prefix && !state.inputState.operator) return [];
  if (/^(?:m|'|`|"|q|@)$/u.test(prefix))
    return [{ key: "名前", label: "マーク・レジスタ名を入力" }];
  const mode: VimMode = state.visualMode
    ? "visual"
    : state.inputState.operator
      ? "operatorPending"
      : "normal";
  const entries = getGuideEntries({ ...settings, engine: "builtin" })
    .filter(
      (entry) =>
        entry.enabled &&
        entry.modes.includes(mode) &&
        entry.keys.startsWith(prefix) &&
        entry.keys !== prefix,
    )
    .map((entry) => ({ key: entry.keys.slice(prefix.length), label: entry.label }));
  return entries.filter(
    (entry, index) => entries.findIndex((other) => other.key === entry.key) === index,
  );
}

/** A passive delayed overlay. Native Vim remains the only input dispatcher. */
export class NativePendingHints {
  private timer?: number;
  private overlay?: HTMLElement;
  private disposed = false;
  private owner: Window;

  constructor(
    private cm: NativeCM,
    private vim: NativeVim,
    private host: BackendHost,
  ) {
    this.owner = cm.cm6.dom.ownerDocument.defaultView ?? window;
  }

  private eligible(): boolean {
    const view = this.cm.cm6;
    const doc = view.dom.ownerDocument;
    const state = this.cm.state as NativeCM["state"] & { dialog?: unknown; overwrite?: boolean };
    const getGlobal = this.vim.getVimGlobalState_ as
      | (() => { macroModeState?: { isPlaying?: boolean; isRecording?: boolean } })
      | undefined;
    const macro = getGlobal?.call(this.vim)?.macroModeState;
    return (
      !this.disposed &&
      this.host.isActive() &&
      this.host.settings().showPendingHints &&
      !!state.vim &&
      !state.vim.insertMode &&
      !state.dialog &&
      !state.overwrite &&
      !view.composing &&
      view.contentDOM.contains(doc.activeElement) &&
      !macro?.isPlaying &&
      !macro?.isRecording &&
      ![...doc.querySelectorAll(".modal-container, .menu, .suggestion-container")].some(
        (element) => element.getClientRects().length > 0,
      )
    );
  }

  private hide(): void {
    if (this.timer !== undefined) this.owner.clearTimeout(this.timer);
    this.timer = undefined;
    this.overlay?.remove();
    this.overlay = undefined;
  }

  refresh(): void {
    this.hide();
    if (!this.eligible() || !nativeHintEntries(this.cm.state.vim!, this.host.settings()).length)
      return;
    this.timer = this.owner.setTimeout(() => {
      this.timer = undefined;
      if (!this.eligible()) return;
      const entries = nativeHintEntries(this.cm.state.vim!, this.host.settings());
      if (!entries.length) return;
      const overlay = child(this.cm.cm6.dom, "div", "lindvimera-pending-hints");
      overlay.setAttribute("role", "note");
      overlay.setAttribute("aria-label", "続けて使える主なVimキー");
      child(overlay, "div", "lindvimera-hint-title", "続けて使える主なキー");
      for (const entry of entries.slice(0, 8)) {
        const row = child(overlay, "div");
        child(row, "kbd", "", entry.key);
        child(row, "span", "", entry.label);
      }
      if (entries.length > 8)
        child(overlay, "div", "", `ほか${entries.length - 8}件 · 続く入力で絞り込み`);
      this.overlay = overlay;
    }, 500);
  }

  destroy(): void {
    this.disposed = true;
    this.hide();
  }
}
