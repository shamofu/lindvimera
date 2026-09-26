import { analyseKeyBindings } from "../input/policy";
import {
  checkedKeyBindings,
  type KeyBinding,
  type LindvimeraSettings,
  type VimMode,
} from "../settings";
import { child } from "./dom";

export const MODE_LABELS: Readonly<Record<VimMode, string>> = {
  normal: "Normal",
  insert: "Insert",
  visual: "Visual",
  operatorPending: "Operator待ち",
};

/** Structural mistakes block Apply; unsupported operations remain visible and saved. */
export function checkedMappingDraft(value: unknown): KeyBinding[] {
  const bindings = checkedKeyBindings(value);
  const cycle = analyseKeyBindings(bindings).issues.find(({ reason }) => reason.includes("循環"));
  if (cycle) throw new Error(cycle.reason);
  return bindings;
}

interface MappingEditorOptions {
  getBindings(): readonly KeyBinding[];
  getSettings?(): LindvimeraSettings;
  save(bindings: KeyBinding[]): Promise<void>;
}

export function renderMappingEditor(
  container: HTMLElement,
  options: MappingEditorOptions,
): () => void {
  const editor = child(container, "div", "lindvimera-mapping-editor");
  child(
    editor,
    "p",
    "setting-item-description",
    "変更は「適用」で保存します。特殊キーは <Esc>、<CR> などのVim表記で指定してください。",
  );
  const rows = child(editor, "div", "lindvimera-mapping-rows");
  const error = child(editor, "div", "lindvimera-setting-error");
  error.setAttribute("role", "status");
  const actions = child(editor, "div", "lindvimera-mapping-actions");
  const add = child(actions, "button", "", "割り当てを追加");
  const apply = child(actions, "button", "mod-cta", "適用");
  const cancel = child(actions, "button", "", "取り消す");
  for (const button of [add, apply, cancel]) button.type = "button";
  let draft = options.getBindings().map((binding) => ({ ...binding }));
  let busy = false;
  let feedback: HTMLElement[] = [];

  const validate = () => {
    let hardError = "";
    try {
      checkedMappingDraft(draft);
    } catch (reason) {
      hardError = reason instanceof Error ? reason.message : String(reason);
    }
    const issues = analyseKeyBindings(draft, options.getSettings?.()).issues;
    feedback.forEach((element, index) => {
      try {
        checkedKeyBindings([draft[index]]);
      } catch (reason) {
        element.textContent = reason instanceof Error ? reason.message : String(reason);
        return;
      }
      const issue = issues.find(({ binding }) => binding === draft[index]);
      element.textContent = issue ? `無効：${issue.reason}` : "";
    });
    error.textContent = hardError;
    const changed = JSON.stringify(draft) !== JSON.stringify(options.getBindings());
    apply.disabled = busy || !!hardError || !changed;
    cancel.disabled = busy || !changed;
    return !hardError;
  };

  const render = () => {
    rows.replaceChildren();
    feedback = [];
    if (!draft.length) child(rows, "p", "setting-item-description", "キー割り当てはありません。");
    draft.forEach((binding, index) => {
      const row = child(rows, "div", "lindvimera-mapping-row");
      const fields = child(row, "div", "lindvimera-mapping-fields");
      const mode = child(fields, "select");
      mode.setAttribute("aria-label", `割り当て ${index + 1} のモード`);
      for (const [value, label] of Object.entries(MODE_LABELS)) {
        const option = child(mode, "option", "", label);
        option.value = value;
      }
      mode.value = binding.mode;
      mode.addEventListener("change", () => {
        binding.mode = mode.value as VimMode;
        validate();
      });
      for (const [key, label] of [
        ["from", "入力キー"],
        ["to", "実行キー列"],
      ] as const) {
        const input = child(fields, "input");
        input.type = "text";
        input.value = binding[key];
        input.placeholder = label;
        input.setAttribute("aria-label", `割り当て ${index + 1} の${label}`);
        input.spellcheck = false;
        input.addEventListener("input", () => {
          binding[key] = input.value;
          validate();
        });
      }
      const remove = child(fields, "button", "", "削除");
      remove.type = "button";
      remove.setAttribute("aria-label", `割り当て ${index + 1} を削除`);
      remove.addEventListener("click", () => {
        draft.splice(index, 1);
        render();
      });
      feedback.push(child(row, "div", "lindvimera-setting-error"));
    });
    validate();
  };
  add.addEventListener("click", () => {
    draft.push({ mode: "normal", from: "", to: "" });
    render();
    rows.querySelector<HTMLInputElement>(".lindvimera-mapping-row:last-child input")?.focus();
  });
  cancel.addEventListener("click", () => {
    draft = options.getBindings().map((binding) => ({ ...binding }));
    render();
  });
  apply.addEventListener("click", () => {
    if (busy || !validate()) return;
    busy = true;
    for (const input of editor.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >("input, select, button"))
      input.disabled = true;
    void options
      .save(checkedMappingDraft(draft))
      .then(() => {
        draft = options.getBindings().map((binding) => ({ ...binding }));
        busy = false;
        add.disabled = false;
        render();
      })
      .catch((reason: unknown) => {
        busy = false;
        for (const input of editor.querySelectorAll<
          HTMLInputElement | HTMLSelectElement | HTMLButtonElement
        >("input, select, button"))
          input.disabled = false;
        validate();
        error.textContent = `保存できませんでした：${reason instanceof Error ? reason.message : String(reason)}`;
      });
  });
  render();
  return () => {
    validate();
  };
}
