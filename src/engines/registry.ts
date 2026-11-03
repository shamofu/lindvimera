import { analyseKeyBindings as embeddedAnalysis } from "../input/policy";
import { analyseKeyBindings as builtinAnalysis } from "./builtin/policy";
import type { EngineId } from "./selection";
import type { EngineModule, MappingAnalyzer } from "./types";

export interface EngineDescriptor {
  id: EngineId;
  label: string;
  experimental: boolean;
  nativeVim: boolean;
  analyse: MappingAnalyzer;
  load(): Promise<EngineModule>;
}

/** The sole composition root. Removing a backend changes this registry, not its peer. */
export const engineRegistry: readonly EngineDescriptor[] = [
  {
    id: "embedded",
    label: "同梱エンジン",
    experimental: false,
    nativeVim: false,
    analyse: embeddedAnalysis,
    load: () => import("./embedded"),
  },
  {
    id: "builtin",
    label: "組み込みVim（実験的）",
    experimental: true,
    nativeVim: true,
    analyse: builtinAnalysis,
    load: () => import("./builtin"),
  },
];

export const defaultEngine: EngineId = "embedded";

export function getEngine(id: EngineId = defaultEngine): EngineDescriptor {
  const engine = engineRegistry.find((entry) => entry.id === id);
  if (!engine) throw new Error(`Vim engine is unavailable: ${id}`);
  return engine;
}
