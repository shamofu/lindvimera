import type {
  CodeMirrorV,
  CommandPolicy,
  InputStateInterface,
  vimKey,
} from "@replit/codemirror-vim-core";
import type { KeyBinding, LindvimeraSettings, VimMode } from "../settings";
import { parseEx } from "./ex-syntax";

import { operatorCommands, SUPPORTED_COMMANDS } from "./commands";
import { analyseMappings, textObjects } from "./mapping-validation";
export { SUPPORTED_COMMANDS, SUPPORTED_EXTENSION_KEYS } from "./commands";

const supportedMotions = new Set([
  "moveToTopLine",
  "moveToMiddleLine",
  "moveToBottomLine",
  "moveByCharacters",
  "moveByLines",
  "moveByDisplayLines",
  "moveByWords",
  "moveByParagraph",
  "moveBySentence",
  "moveByPage",
  "moveByScroll",
  "moveToLineOrEdgeOfDocument",
  "moveToStartOfLine",
  "moveToFirstNonWhiteSpaceCharacter",
  "moveToEol",
  "moveToMatchedSymbol",
  "moveToCharacter",
  "moveTillCharacter",
  "repeatLastCharacterSearch",
  "moveToOtherHighlightedEnd",
  "expandToLine",
  "findNext",
  "findAndSelectNextInclusive",
  "textObjectManipulation",
]);
const supportedOperators = new Set<string>(Object.values(operatorCommands));
const supportedActions = new Set([
  "enterInsertMode",
  "newLineAndEnterInsertMode",
  "toggleVisualMode",
  "reselectLastSelection",
  "joinLines",
  "paste",
  "replace",
  "replayMacro",
  "enterMacroRecordMode",
  "undo",
  "redo",
  "setRegister",
  "scrollToCursor",
  "repeatLastEdit",
]);
const builtinAliases: Readonly<Record<string, readonly string[]>> = {
  "<Left>": ["h"],
  "<Right>": ["l"],
  "<Up>": ["k"],
  "<Down>": ["j"],
  "g<Up>": ["gk"],
  "g<Down>": ["gj"],
  "<BS>": ["h"],
  "<Del>": ["x"],
  "<C-[>": ["<Esc>"],
  "<C-c>": ["<Esc>"],
  s: ["cl", "c"],
  S: ["cc", "VdO"],
  "<Home>": ["0"],
  "<End>": ["$"],
  "<PageUp>": ["<C-b>"],
  "<PageDown>": ["<C-f>"],
  "<CR>": ["j^"],
};

function builtinAllowed(command: vimKey, context: string, keys: string): boolean {
  if (
    !SUPPORTED_COMMANDS.some(
      (entry) => entry.keys === command.keys && entry.contexts.includes(context as VimMode),
    )
  )
    return false;
  if (command.type === "ex") return command.keys === ":";
  if (command.type === "keyToEx") return false;
  if (command.type === "keyToKey") return !!builtinAliases[command.keys]?.includes(command.toKeys);
  if ("motion" in command && command.motion && !supportedMotions.has(command.motion)) return false;
  if ("operator" in command && command.operator && !supportedOperators.has(command.operator))
    return false;
  if ("action" in command && !supportedActions.has(command.action)) return false;
  if (command.type === "motion" && command.motion === "textObjectManipulation") {
    // Both partial candidates survive, but a complete unsupported object does not.
    return keys === command.keys || keys.length === 1 || textObjects.has(keys.slice(1));
  }
  return true;
}

/** Embedded semantics are injected into the shared structural grammar. */
export function analyseKeyBindings(bindings: readonly KeyBinding[], settings?: LindvimeraSettings) {
  return analyseMappings(bindings, settings, {
    strict: true,
    parseEx: (input, pcre) => parseEx(input, { pcre }),
  });
}

function extensionEnabled(name: string, settings: LindvimeraSettings): boolean {
  // ^ remains a supported builtin when its recorded motion falls back after a setting change.
  if (name === "lindvimeraContentStart") return true;
  if (name === "lindvimeraContentVertical") return true;
  if (name === "lindvimeraDisplayVertical") return true;
  if (name === "lindvimeraLiveCharacter") return true;
  if (name === "lindvimeraLiveWord") return true;
  if (name.startsWith("lindvimeraFold")) return settings.folding;
  if (name.startsWith("lindvimeraSurround")) return settings.surround;
  if (name.startsWith("lindvimeraObject")) return settings.textObjects;
  if (name === "lindvimeraheading" || name === "lindvimeralist") return settings.markdownMotions;
  if (name === "lindvimeraCell" || name === "lindvimeraLeaveTable") return settings.tables;
  return name === "lindvimeraOpenLink";
}

export function installCommandPolicy(
  cm: CodeMirrorV,
  settings: () => LindvimeraSettings,
  onRejected: (message: string) => void = () => {},
): () => void {
  const previous = cm.state.commandPolicy;
  let previousBindings: readonly KeyBinding[] | undefined;
  let previousFeatures = "";
  let bindings: KeyBinding[] = [];
  const policy: CommandPolicy = {
    allowsEx(command) {
      return [
        "set",
        "move",
        "substitute",
        "delete",
        "yank",
        "put",
        "join",
        "sort",
        "nohlsearch",
      ].includes(command.name);
    },
    allows(command, context, keys) {
      const current = settings();
      const features = [
        current.markdownMotions,
        current.textObjects,
        current.surround,
        current.tables,
        current.folding,
      ].join(",");
      if (previousBindings !== current.keyBindings || previousFeatures !== features) {
        previousBindings = current.keyBindings;
        previousFeatures = features;
        bindings = analyseKeyBindings(current.keyBindings, current).active;
      }
      if (
        command.type === "keyToKey" &&
        bindings.some(
          (binding) =>
            binding.mode === context &&
            binding.from === command.keys &&
            binding.to === command.toKeys,
        )
      )
        return true;
      const name =
        "action" in command
          ? command.action
          : "motion" in command
            ? command.motion
            : "operator" in command
              ? command.operator
              : "";
      if (["lindvimeraSetMark", "lindvimeraGoToMark"].includes(name))
        return (
          context === "normal" &&
          (keys === command.keys || keys.length === 1 || /^[m'`][a-z]$/.test(keys))
        );
      if (["lindvimeraJumpBack", "lindvimeraJumpForward"].includes(name))
        return context === "normal";
      if (name.startsWith("lindvimera")) return extensionEnabled(name, current);
      return builtinAllowed(command, context, keys);
    },
    allowsReplay(input, action) {
      const current = settings();
      if (action && !policy.allows(action, action.context ?? "normal", action.keys)) return false;
      return replayInputAllowed(input, current);
    },
    onRejected(keys) {
      onRejected(`未対応のVim操作の再生を中止しました: ${keys}`);
    },
  };
  cm.state.commandPolicy = policy;
  return () => {
    if (cm.state.commandPolicy === policy) cm.state.commandPolicy = previous;
  };
}

function replayInputAllowed(
  input: InputStateInterface | void,
  settings: LindvimeraSettings,
): boolean {
  if (!input) return true;
  if (
    input.operator &&
    !supportedOperators.has(input.operator) &&
    !extensionEnabled(input.operator, settings)
  )
    return false;
  if (
    input.motion &&
    !supportedMotions.has(input.motion) &&
    !extensionEnabled(input.motion, settings)
  )
    return false;
  if (
    input.motion === "textObjectManipulation" &&
    !textObjects.has(input.selectedCharacter ?? input.motionArgs?.selectedCharacter ?? "")
  )
    return false;
  return true;
}
