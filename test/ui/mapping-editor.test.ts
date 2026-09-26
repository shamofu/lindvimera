import { describe, expect, it, vi } from "vitest";
import { checkedMappingDraft, renderMappingEditor } from "../../src/ui/mapping-editor";
import { loadSettings, type KeyBinding } from "../../src/settings";

function setup(initial: KeyBinding[] = []) {
  const container = document.createElement("div");
  let saved = initial;
  const save = vi.fn(async (bindings: KeyBinding[]) => {
    saved = bindings;
  });
  renderMappingEditor(container, { getBindings: () => saved, save });
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label)!;
  const edit = (index: number, field: "from" | "to", value: string) => {
    const input = container.querySelectorAll<HTMLInputElement>(
      `.lindvimera-mapping-row:nth-child(${index + 1}) input`,
    )[field === "from" ? 0 : 1];
    input.value = value;
    input.dispatchEvent(new Event("input"));
  };
  return { container, save, button, edit, saved: () => saved };
}

describe("draft mapping form", () => {
  it("adds, edits and cancels without saving or changing the original array", () => {
    const original: KeyBinding[] = [{ mode: "normal", from: "H", to: "0" }];
    const form = setup(original);
    form.edit(0, "to", "^");
    form.button("割り当てを追加").click();
    form.edit(1, "from", "Q");
    form.edit(1, "to", "dw");
    expect(form.button("適用").disabled).toBe(false);
    expect(form.saved()).toBe(original);
    expect(original[0].to).toBe("0");
    expect(form.save).not.toHaveBeenCalled();
    form.button("取り消す").click();
    expect(form.container.querySelectorAll(".lindvimera-mapping-row")).toHaveLength(1);
    expect(form.container.querySelectorAll("input")[1].value).toBe("0");
    expect(form.button("適用").disabled).toBe(true);
  });

  it("blocks empty fields, duplicate rows and cycles before persistence", () => {
    const form = setup([{ mode: "normal", from: "Q", to: "dw" }]);
    form.button("割り当てを追加").click();
    expect(form.button("適用").disabled).toBe(true);
    expect(
      form.container.querySelector(".lindvimera-mapping-row:nth-child(2) .lindvimera-setting-error")
        ?.textContent,
    ).toContain("mode・from・to");
    form.edit(1, "from", "Q");
    form.edit(1, "to", "yw");
    expect(form.container.textContent).toContain("重複");
    expect(form.button("適用").disabled).toBe(true);
    form.edit(1, "from", "Z");
    form.edit(1, "to", "Qw");
    form.edit(0, "to", "Zj");
    expect(form.container.textContent).toContain("循環");
    expect(form.button("適用").disabled).toBe(true);
    expect(form.save).not.toHaveBeenCalled();
  });

  it("preserves unsupported mappings with a reason and saves the structured draft once", async () => {
    const form = setup();
    form.button("割り当てを追加").click();
    form.edit(0, "from", "Q");
    form.edit(0, "to", ":write<CR>");
    expect(form.container.textContent).toContain("無効");
    expect(form.container.textContent).toContain("未対応");
    expect(form.button("適用").disabled).toBe(false);
    form.button("適用").click();
    expect(form.button("適用").disabled).toBe(true);
    await vi.waitFor(() => expect(form.save).toHaveBeenCalledOnce());
    expect(form.saved()).toEqual([{ mode: "normal", from: "Q", to: ":write<CR>" }]);
    expect(form.container.textContent).toContain("無効");
  });

  it("removes one row without changing saved definitions before Apply", async () => {
    const form = setup([{ mode: "normal", from: "Q", to: "dw" }]);
    form.button("削除").click();
    expect(form.saved()).toHaveLength(1);
    form.button("適用").click();
    await vi.waitFor(() => expect(form.save).toHaveBeenCalledWith([]));
  });

  it("shows save failures and allows retry without discarding the draft", async () => {
    const form = setup([{ mode: "normal", from: "Q", to: "dw" }]);
    form.save.mockRejectedValueOnce(new Error("disk unavailable"));
    form.edit(0, "to", "yw");
    form.button("適用").click();
    await vi.waitFor(() => expect(form.container.textContent).toContain("disk unavailable"));
    expect(form.container.querySelectorAll("input")[1].value).toBe("yw");
    expect(form.button("適用").disabled).toBe(false);
    form.button("適用").click();
    await vi.waitFor(() => expect(form.save).toHaveBeenCalledTimes(2));
    expect(form.saved()[0].to).toBe("yw");
  });

  it("rejects cycles across expanded command sequences but accepts unsupported definitions", () => {
    expect(() =>
      checkedMappingDraft([
        { mode: "normal", from: "Q", to: "Zj" },
        { mode: "normal", from: "Z", to: "Qw" },
      ]),
    ).toThrow(/循環/);
    expect(checkedMappingDraft([{ mode: "normal", from: "Q", to: "gq" }])).toHaveLength(1);
  });

  it("refreshes disabled-feature reasons without discarding the draft", () => {
    const container = document.createElement("div");
    const settings = loadSettings({ keyBindings: [{ mode: "normal", from: "Q", to: "za" }] });
    const refresh = renderMappingEditor(container, {
      getBindings: () => settings.keyBindings,
      getSettings: () => settings,
      save: vi.fn(),
    });
    expect(
      container.querySelector(".lindvimera-mapping-row .lindvimera-setting-error")?.textContent,
    ).toBe("");
    settings.folding = false;
    refresh();
    expect(
      container.querySelector(".lindvimera-mapping-row .lindvimera-setting-error")?.textContent,
    ).toContain("無効");
    expect(container.querySelectorAll("input")[1].value).toBe("za");
  });
});
