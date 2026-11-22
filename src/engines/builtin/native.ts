import type { EditorView } from "@codemirror/view";
import type { WordDocument, WordPosition } from "../../word";

export type Position = WordPosition;
export interface NativeRange {
  anchor: Position;
  head: Position;
}
export interface NativeArgs {
  repeat: number;
  forward?: boolean;
  wordEnd?: boolean;
  inclusive?: boolean;
  bigWord?: boolean;
  textObjectInner?: boolean;
  linewise?: boolean;
  selectedCharacter?: string;
  replacement?: string;
  count?: number;
  [key: string]: unknown;
}
export interface NativeInput {
  operator?: string;
  operatorShortcut?: string;
  operatorArgs?: NativeArgs;
  motion?: string;
  keyBuffer: string[];
  prefixRepeat?: string[];
  motionRepeat?: string[];
  registerName?: string;
  getRepeat(): number;
  [key: string]: unknown;
}
export interface NativeState {
  insertMode?: boolean;
  insertModeRepeat?: number;
  visualMode?: boolean;
  visualLine?: boolean;
  visualBlock?: boolean;
  expectLiteralNext?: boolean;
  mode?: string;
  status?: string;
  lastHPos?: number;
  lastHSPos?: number;
  inputState: NativeInput;
  sel: NativeRange;
  lastEditInputState?: NativeInput;
  lastEditActionCommand?: unknown;
  marks?: Record<string, { clear?(): void }>;
}
export interface NativeCM extends WordDocument {
  cm6: EditorView;
  curOp?: unknown;
  state: { vim?: NativeState; overwrite?: boolean };
  getValue(): string;
  getCursor(which?: string): Position;
  setCursor: (position: Position | number, ch?: number) => void;
  setSelections?: (ranges: NativeRange[], primary?: number) => void;
  findPosV?(
    head: Position,
    amount: number,
    unit: string,
    horizontal?: number,
  ): Position & { focusBefore?: () => void; hitSide?: boolean };
  charCoords?(head: Position, mode: string): { left: number };
  indexFromPos(position: Position): number;
  posFromIndex(offset: number): Position;
  replaceRange(text: string, from: Position, to?: Position): void;
  operation<T>(action: () => T): T;
  on(event: string, callback: (...args: unknown[]) => void): void;
  off(event: string, callback: (...args: unknown[]) => void): void;
}
export type NativeMotion = (
  cm: NativeCM,
  head: Position,
  args: NativeArgs,
  vim: NativeState,
  input: NativeInput,
) => Position | [Position, Position] | undefined | null;
export type NativeAction = (cm: NativeCM, args: NativeArgs, vim: NativeState) => void;
export type NativeOperator = (
  cm: NativeCM,
  args: NativeArgs,
  ranges: NativeRange[],
) => Position | undefined;
export interface NativeCommand {
  keys: string;
  type: "motion" | "action" | "operator" | "keyToKey" | "keyToEx";
  context?: string;
  motion?: string;
  motionArgs?: Partial<NativeArgs>;
  action?: string;
  actionArgs?: Partial<NativeArgs>;
  operator?: string;
  operatorArgs?: Partial<NativeArgs>;
  toKeys?: string;
  noremap?: boolean;
  exArgs?: { input: string };
  isEdit?: boolean;
  interlaceInsertRepeat?: boolean;
}
export interface NativeVim {
  findKey: (cm: NativeCM, key: string, origin?: string) => (() => unknown) | undefined;
  handleKey(cm: NativeCM, key: string, origin?: string): unknown;
  defineMotion(name: string, callback: NativeMotion): void;
  defineAction(name: string, callback: NativeAction): void;
  defineOperator(name: string, callback: NativeOperator): void;
  _mapCommand(command: NativeCommand): void;
  unmap(keys: string, context?: string): boolean | undefined;
  exitVisualMode(cm: NativeCM, move?: boolean): void;
  enterInsertMode?: (cm: NativeCM) => void;
  exitInsertMode?: (cm: NativeCM, keepCursor?: boolean) => void;
  getOption?(name: string): unknown;
  setOption?(name: string, value: unknown): void;
  getVimGlobalState_?: () =>
    | {
        macroModeState?: {
          isRecording?: boolean;
          latestRegister?: string;
          isPlaying?: boolean;
        };
      }
    | undefined;
  [key: string]: unknown;
}
export interface NativeWindow extends Window {
  CodeMirrorAdapter?: { Vim?: NativeVim };
}

export function getNativeVim(owner: Window): NativeVim | undefined {
  const vim = (owner as NativeWindow).CodeMirrorAdapter?.Vim;
  return vim &&
    typeof vim.findKey === "function" &&
    typeof vim._mapCommand === "function" &&
    typeof vim.unmap === "function" &&
    typeof vim.defineMotion === "function" &&
    typeof vim.defineAction === "function" &&
    typeof vim.defineOperator === "function" &&
    typeof vim.getRegisterController === "function" &&
    typeof vim.getVimGlobalState_ === "function"
    ? vim
    : undefined;
}

export function getNativeCM(view: EditorView): NativeCM | undefined {
  const cm = (view as EditorView & { cm?: NativeCM }).cm;
  return cm?.cm6 === view && cm.state.vim ? cm : undefined;
}

/** Lookup is synchronous. Remove only this exact object by an unforgeable context.
 * Native unmap compares keys + context; a unique temporary context during removal
 * prevents a nested/foreign map from ever being removed in its place. */
export function withMappings<T>(
  vim: NativeVim,
  commands: readonly NativeCommand[],
  run: () => T,
): T {
  const installed: NativeCommand[] = [];
  try {
    for (const command of commands) {
      installed.push(command);
      vim._mapCommand(command);
    }
    return run();
  } finally {
    for (const command of installed.reverse()) {
      const context = command.context;
      // Only native equality checks consume this value; it is never persisted.
      command.context = {} as string;
      try {
        vim.unmap(command.keys, command.context);
      } finally {
        command.context = context;
      }
    }
  }
}
