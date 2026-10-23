import { describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../src/settings";
import { renderCommandGuide } from "../../src/ui/guide";

vi.mock("obsidian", () => ({ Modal: class {} }));
vi.mock("../../src/input/catalog", () => ({
  getGuideEntries: () => [
    {
      keys: "w",
      label: "単語へ移動",
      category: "移動",
      description: "次の単語へ移動します。",
      example: "2w",
      modes: ["normal", "visual", "operatorPending"],
      enabled: true,
    },
    {
      keys: "za",
      label: "折り畳み",
      category: "表示",
      description: "見出しを折り畳みます。",
      example: "za",
      modes: ["normal"],
      enabled: false,
      reason: "設定で折り畳みが無効です。",
    },
    {
      keys: "Q",
      label: "ユーザー割り当て",
      category: "割り当て",
      description: "<img src=x onerror=alert(1)>",
      example: "Q → dw",
      modes: ["normal"],
      enabled: true,
    },
  ],
}));

describe("searchable command guide", () => {
  it("makes the operation results a named keyboard focus target", () => {
    const container = document.createElement("div");
    document.body.append(container);
    try {
      renderCommandGuide(container, () => loadSettings(undefined));
      const results = container.querySelector<HTMLElement>(
        '[role="region"][aria-label="操作一覧"]',
      );
      expect(results).not.toBeNull();
      expect(results?.tabIndex).toBe(0);
      results?.focus();
      expect(document.activeElement).toBe(results);
    } finally {
      container.remove();
    }
  });

  it.each([
    { name: "search", selector: "input", value: "単語", event: "input" },
    {
      name: "mode",
      selector: 'select[aria-label="ガイドのモード"]',
      value: "visual",
      event: "change",
    },
    {
      name: "category",
      selector: 'select[aria-label="ガイドの分類"]',
      value: "表示",
      event: "change",
    },
  ])("returns results to the top when the $name filter changes", ({ selector, value, event }) => {
    const container = document.createElement("div");
    renderCommandGuide(container, () => loadSettings(undefined));
    const results = container.querySelector<HTMLElement>(".lindvimera-guide-results")!;
    const filter = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
    // jsdom does not lay out content; this checks the refresh side effect only.
    results.scrollTop = 120;
    filter.value = value;
    filter.dispatchEvent(new Event(event));
    expect(results.querySelectorAll("article")).toHaveLength(1);
    expect(results.scrollTop).toBe(0);
  });

  it("filters by text, mode and category without changing settings", () => {
    const container = document.createElement("div");
    const settings = loadSettings(undefined);
    const before = structuredClone(settings);
    const search = renderCommandGuide(container, () => settings);
    expect(container.querySelectorAll("article")).toHaveLength(3);
    search.value = "単語";
    search.dispatchEvent(new Event("input"));
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.textContent).toContain("2w");
    search.value = "";
    search.dispatchEvent(new Event("input"));
    const selects = container.querySelectorAll("select");
    selects[0].value = "visual";
    selects[0].dispatchEvent(new Event("change"));
    expect(container.querySelectorAll("article")).toHaveLength(1);
    selects[1].value = "表示";
    selects[1].dispatchEvent(new Event("change"));
    expect(container.textContent).toContain("一致する操作はありません");
    expect(settings).toEqual(before);
  });

  it("keeps disabled commands discoverable and renders user text without HTML interpretation", () => {
    const container = document.createElement("div");
    const search = renderCommandGuide(container, () => loadSettings(undefined));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    search.value = "za";
    search.dispatchEvent(new Event("input"));
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.textContent).toContain("現在は無効：設定で折り畳みが無効です。");
  });
});
