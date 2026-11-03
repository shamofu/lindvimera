import { checkedKeyBindings, type KeyBinding, type LindvimeraSettings } from "../../settings";
import { analyseMappings } from "../../input/mapping-validation";
import type { MappingAnalysis } from "../types";

/** Share mode-aware structural checks, leaving native command semantics to Obsidian. */
export function analyseKeyBindings(
  bindings: readonly KeyBinding[],
  settings?: LindvimeraSettings,
): MappingAnalysis {
  return analyseMappings(bindings, settings, {
    validateBinding(binding) {
      try {
        checkedKeyBindings([binding]);
        if (/^<(?:Esc|C-c|C-\[)>$/iu.test(binding.from)) return "取り消しキーは変更できません。";
        // Literal < and > are Vim operators. Angle-bracket key names must close.
        if (/<(?:[CSMA]-|Esc|CR|Tab)[^>]*$/iu.test(binding.from))
          return "割り当て元のキー表記が不正です。";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
}
