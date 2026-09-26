import { Modal, type App } from "obsidian";
import { getGuideEntries } from "../input/catalog";
import type { LindvimeraSettings, VimMode } from "../settings";
import { child } from "./dom";
import { MODE_LABELS } from "./mapping-editor";

/** Rendering is read-only: no key simulation, mappings, or editor state changes. */
export function renderCommandGuide(
  container: HTMLElement,
  settings: () => LindvimeraSettings,
): HTMLInputElement {
  const controls = child(container, "div", "lindvimera-guide-controls");
  const search = child(controls, "input");
  search.type = "search";
  search.placeholder = "キー・操作名・説明を検索";
  search.setAttribute("aria-label", "操作ガイドを検索");
  const mode = child(controls, "select");
  mode.setAttribute("aria-label", "ガイドのモード");
  const allModes = child(mode, "option", "", "すべてのモード");
  allModes.value = "";
  for (const [value, label] of Object.entries(MODE_LABELS)) {
    child(mode, "option", "", label).value = value;
  }
  const category = child(controls, "select");
  category.setAttribute("aria-label", "ガイドの分類");
  child(category, "option", "", "すべての分類").value = "";
  for (const value of new Set(getGuideEntries(settings()).map((entry) => entry.category))) {
    child(category, "option", "", value).value = value;
  }
  const count = child(container, "p", "setting-item-description");
  count.setAttribute("role", "status");
  const results = child(container, "div", "lindvimera-guide-results");
  const refresh = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const terms = query.split(/\s+/u).filter(Boolean);
    const entries = getGuideEntries(settings()).filter((entry) => {
      if (mode.value && !entry.modes.includes(mode.value as VimMode)) return false;
      if (category.value && category.value !== entry.category) return false;
      const text = [
        entry.keys,
        entry.label,
        entry.description,
        entry.example,
        entry.category,
        entry.reason ?? "",
      ]
        .join(" ")
        .toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
    results.replaceChildren();
    count.textContent = `${entries.length}件の操作`;
    if (!entries.length) child(results, "p", "", "一致する操作はありません。");
    for (const entry of entries) {
      const row = child(results, "article", "lindvimera-guide-entry");
      const heading = child(row, "div", "lindvimera-guide-heading");
      child(heading, "code", "", entry.keys);
      child(heading, "strong", "", entry.label);
      child(
        row,
        "div",
        "setting-item-description",
        `${entry.category} · ${entry.modes.map((value) => MODE_LABELS[value]).join(" / ")}`,
      );
      child(row, "p", "", entry.description);
      if (entry.example) child(row, "code", "lindvimera-guide-example", entry.example);
      if (!entry.enabled)
        child(
          row,
          "div",
          "lindvimera-setting-error",
          `現在は無効：${entry.reason ?? "設定で無効になっています。"}`,
        );
    }
  };
  search.addEventListener("input", refresh);
  mode.addEventListener("change", refresh);
  category.addEventListener("change", refresh);
  refresh();
  return search;
}

export function openCommandGuide(app: App, settings: () => LindvimeraSettings): void {
  class CommandGuideModal extends Modal {
    override onOpen(): void {
      this.titleEl.textContent = "Lindvimeraの操作ガイド";
      this.modalEl.classList.add("lindvimera-guide-modal");
      renderCommandGuide(this.contentEl, settings).focus();
    }

    override onClose(): void {
      this.contentEl.replaceChildren();
    }
  }
  new CommandGuideModal(app).open();
}
