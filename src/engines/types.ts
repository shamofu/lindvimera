import type { Extension } from "@codemirror/state";
import type { App } from "obsidian";
import type { KeyBinding, LindvimeraSettings } from "../settings";
import type { JapaneseSegmenter } from "../word";

export interface MappingIssue {
  binding: KeyBinding;
  reason: string;
}

export interface MappingAnalysis {
  active: KeyBinding[];
  issues: MappingIssue[];
}

export type MappingAnalyzer = (
  bindings: readonly KeyBinding[],
  settings?: LindvimeraSettings,
) => MappingAnalysis;

/** Lifecycle only: concrete Vim state must never cross this boundary. */
export interface BackendHost {
  app: App;
  settings: () => LindvimeraSettings;
  wordSegmenter: () => JapaneseSegmenter;
  isActive: () => boolean;
  reportMode: (mode: string) => void;
  reportError: (message: string) => void;
  registerEditorExtension: (extension: Extension) => void;
}

export interface EngineBackend {
  refresh(): void;
  flush(): void;
  applySettings(appearanceOnly?: boolean): void;
  dispose(): void;
  /** Opaque, backend-owned fixture adapter; never consumed by shared runtime code. */
  readonly runtime: object;
}

export interface EngineModule {
  createBackend(host: BackendHost): EngineBackend;
}
