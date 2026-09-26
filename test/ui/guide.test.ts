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
