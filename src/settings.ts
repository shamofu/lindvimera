import { checkedEscapeSettings } from "./input/escape";
import type { LinderaMode } from "./word/service";
import { isEngineId, type EngineId } from "./engines/selection";

export type VimMode = "normal" | "insert" | "visual" | "operatorPending";
export interface KeyBinding {
  mode: VimMode;
  from: string;
  to: string;
}

export interface LindvimeraSettings {
  /** Absent in legacy settings: do not take ownership of the host Vim flag. */
  engine?: EngineId;
  enabled: boolean;
  japanese: boolean;
  linderaMode: LinderaMode;
  markdownMotions: boolean;
  markdownEditing: boolean;
  textObjects: boolean;
  surround: boolean;
  folding: boolean;
  tables: boolean;
  showStatus: boolean;
  showPendingHints: boolean;
  cursorColor: string | null;
  escapeSequences: string[];
  escapeTimeoutMs: number;
  keyBindings: KeyBinding[];
}

export const DEFAULT_SETTINGS: LindvimeraSettings = {
  enabled: true,
  japanese: true,
  linderaMode: "normal",
  markdownMotions: true,
  markdownEditing: true,
  textObjects: true,
  surround: true,
  folding: true,
  tables: true,
  showStatus: true,
  showPendingHints: true,
  cursorColor: null,
  escapeSequences: [],
  escapeTimeoutMs: 200,
  keyBindings: [],
};

export function checkedCursorColor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value))
    throw new Error("カーソルの色は #RRGGBB 形式で指定してください。");
  return value.toLowerCase();
}

function readKeyBindings(value: unknown): KeyBinding[] {
  if (!Array.isArray(value)) throw new Error("キー割り当てはJSON配列で指定してください。");
  const modes: readonly string[] = ["normal", "insert", "visual", "operatorPending"];
  const seen = new Set<string>();
  const bindings = value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("キー割り当ての形式が不正です。");
    const binding = entry as KeyBinding;
    if (
      !modes.includes(binding.mode) ||
      typeof binding.from !== "string" ||
      typeof binding.to !== "string" ||
      !binding.from ||
      !binding.to ||
      /[\r\n]/.test(binding.from + binding.to)
    )
      throw new Error("mode・from・toを指定してください。");
    const key = `${binding.mode}:${binding.from}`;
    if (seen.has(key)) throw new Error(`割り当てが重複しています: ${key}`);
    seen.add(key);
    return { mode: binding.mode, from: binding.from, to: binding.to };
  });
  return bindings;
}

export function checkedKeyBindings(value: unknown): KeyBinding[] {
  const bindings = readKeyBindings(value);
  for (const binding of bindings) {
    const visited = new Set<string>([binding.from]);
    let next = binding.to;
    while (next) {
      if (visited.has(next)) throw new Error(`循環する割り当てです: ${binding.from}`);
      visited.add(next);
      next = bindings.find((entry) => entry.mode === binding.mode && entry.from === next)?.to ?? "";
    }
  }
  return bindings;
}

export function loadSettings(value: unknown): LindvimeraSettings {
  const result = {
    ...DEFAULT_SETTINGS,
    escapeSequences: [...DEFAULT_SETTINGS.escapeSequences],
    keyBindings: DEFAULT_SETTINGS.keyBindings.map((binding) => ({ ...binding })),
  };
  if (!value || typeof value !== "object") return result;
  const data = value as Partial<LindvimeraSettings>;
  if (isEngineId(data.engine)) result.engine = data.engine;
  const flags = [
    "enabled",
    "japanese",
    "markdownMotions",
    "markdownEditing",
    "textObjects",
    "surround",
    "folding",
    "tables",
    "showStatus",
    "showPendingHints",
  ] as const;
  for (const key of flags) if (typeof data[key] === "boolean") result[key] = data[key];
  result.linderaMode = data.linderaMode === "decompose" ? "decompose" : "normal";
  try {
    result.cursorColor = checkedCursorColor(data.cursorColor);
  } catch {
    /* Older or malformed color settings retain the existing cursor appearance. */
  }
  try {
    const escape = checkedEscapeSettings({
      sequences: data.escapeSequences ?? result.escapeSequences,
      timeoutMs: data.escapeTimeoutMs ?? result.escapeTimeoutMs,
    });
    result.escapeSequences = [...escape.sequences];
    result.escapeTimeoutMs = escape.timeoutMs;
  } catch {
    /* Recover invalid saved settings without disabling the entire plugin. */
  }
  if (Array.isArray(data.keyBindings)) {
    // Recover each saved row independently. Semantic failures remain visible in
    // the settings UI rather than deleting every user mapping during startup.
    result.keyBindings = data.keyBindings.flatMap((entry) => {
      try {
        return readKeyBindings([entry]);
      } catch {
        return [];
      }
    });
  }
  return result;
}
