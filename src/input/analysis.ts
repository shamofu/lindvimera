import { defaultEngine, getEngine } from "../engines/registry";
import type { MappingAnalysis } from "../engines/types";
import type { KeyBinding, LindvimeraSettings } from "../settings";

/** UI policy follows the requested backend; applying it still requires a reload. */
export function analyseKeyBindings(
  bindings: readonly KeyBinding[],
  settings?: LindvimeraSettings,
): MappingAnalysis {
  return getEngine(settings?.engine ?? defaultEngine).analyse(bindings, settings);
}
