import type {
  CodeMirrorV,
  CommandPolicy,
  InputStateInterface,
  vimKey,
} from "@replit/codemirror-vim-core";
import type { KeyBinding, LindvimeraSettings, VimMode } from "../settings";
import { parseEx } from "../ex/parser";

const movementModes: readonly VimMode[] = ["normal", "visual", "operatorPending"];
const selectionModes: readonly VimMode[] = ["normal", "visual"];
const operatorCommands = {
  d: "delete",
  c: "change",
  y: "yank",
  "=": "indentAuto",
  ">": "indent",
  "<": "indent",
  gu: "changeCase",
  gU: "changeCase",
  "g~": "changeCase",
} as const;

interface SupportedCommand {
  keys: string;
  contexts: readonly VimMode[];
  operator?: string;
  enters?: "insert" | "visual" | "normal";
  visualKind?: "character" | "line" | "block";
  togglesVisual?: boolean;
}

/** The finite public editing vocabulary. Literal arguments are checked separately. */
export const SUPPORTED_COMMANDS: readonly SupportedCommand[] = [
  { keys: ":", contexts: selectionModes, enters: "normal" },
  ...Object.entries(operatorCommands).map(([keys, operator]) => ({
    keys,
    operator,
    contexts: movementModes,
  })),
  ...[
    "h",
    "j",
    "k",
    "l",
    "w",
    "W",
    "b",
    "B",
    "e",
    "E",
    "ge",
    "gE",
    "{",
    "}",
    "(",
    ")",
    "+",
    "-",
    "_",
    "0",
    "^",
    "$",
    "gg",
    "G",
    "f<character>",
    "F<character>",
    "t<character>",
    "T<character>",
    ";",
    ",",
    "%",
    "gj",
    "gk",
    "<C-f>",
    "<C-b>",
    "<C-d>",
    "<C-u>",
    "H",
    "M",
    "L",
    "<Left>",
    "<Right>",
    "<Up>",
    "<Down>",
    "g<Up>",
    "g<Down>",
    "<Home>",
    "<End>",
    "<PageUp>",
    "<PageDown>",
    "<BS>",
    "n",
    "N",
    "*",
    "#",
    "g*",
    "g#",
  ].map((keys) => ({ keys, contexts: movementModes })),
  ...["gn", "gN"].map((keys) => ({
    keys,
    contexts: movementModes,
    enters: "visual" as const,
    visualKind: "character" as const,
  })),
  ...["x", "X", "D", "Y", "p", "P", "J", "gJ", "~", "r<character>", "<Del>"].map((keys) => ({
    keys,
    contexts: selectionModes,
    enters: "normal" as const,
  })),
  ...["<C-r>", "zz", "zt", "zb", '"<register>', "<C-[>", "<C-c>", "/", "?"].map((keys) => ({
    keys,
    contexts: selectionModes,
  })),
  ...["I", "A", "R", "C", "s", "S"].map((keys) => ({
    keys,
    contexts: selectionModes,
    enters: "insert" as const,
  })),
  ...(["v", "V", "<C-v>"] as const).map((keys) => ({
    keys,
    contexts: selectionModes,
    enters: "visual" as const,
    visualKind: ({ v: "character", V: "line", "<C-v>": "block" } as const)[keys],
    togglesVisual: true,
  })),
  { keys: "gv", contexts: selectionModes, enters: "visual" },
  ...["i", "a", "o", "O"].map((keys) => ({
    keys,
    contexts: ["normal"] as readonly VimMode[],
    enters: "insert" as const,
  })),
  ...[
    "u",
    ".",
    "q<register>",
    "@<register>",
    "m<register>",
    "'<register>",
    "`<register>",
    "<C-o>",
    "<C-i>",
    "<CR>",
  ].map((keys) => ({
    keys,
    contexts: ["normal"] as readonly VimMode[],
  })),
  ...["o", "O"].map((keys) => ({ keys, contexts: ["visual"] as readonly VimMode[] })),
  ...["u", "U"].map((keys) => ({
    keys,
    contexts: ["visual"] as readonly VimMode[],
    enters: "normal" as const,
  })),
  ...["i<register>", "a<register>"].map((keys) => ({
    keys,
    contexts: ["visual", "operatorPending"] as readonly VimMode[],
  })),
  { keys: "<C-[>", contexts: ["insert", "operatorPending"] },
  { keys: "<C-c>", contexts: ["operatorPending"] },
  { keys: "<Esc>", contexts: ["normal", "insert", "visual", "operatorPending"] },
];

export const SUPPORTED_EXTENSION_KEYS = [
  "gf",
  "[h",
  "]h",
  "[l",
  "]l",
  "i*",
  "a*",
  "i_",
  "a_",
  "i`",
  "a`",
  "il",
  "al",
  "iC",
  "aC",
  "ys",
  "ds",
  "cs",
  "gS",
  "<Tab>",
  "<S-Tab>",
  "[t",
  "]t",
] as const;

const nativeInsertKeys = new Set([
  "<CR>",
  "<Tab>",
  "<S-Tab>",
  "<BS>",
  "<Del>",
  "<Left>",
  "<Right>",
  "<Up>",
  "<Down>",
  "<Home>",
  "<End>",
  "<PageUp>",
  "<PageDown>",
  "<Space>",
  "<lt>",
]);
const textObjects = new Set("wWspbB()[]{}<>\"'`");
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

export interface KeyBindingIssue {
  binding: KeyBinding;
  reason: string;
}

/** Keep saved definitions intact and disable only invalid definitions/dependents. */
export function analyseKeyBindings(bindings: readonly KeyBinding[]): {
  active: KeyBinding[];
  issues: KeyBindingIssue[];
} {
  const failures = new Map<KeyBinding, string>();
  for (const binding of bindings) {
    if (
      bindings.filter((other) => other.mode === binding.mode && other.from === binding.from)
        .length > 1
    )
      failures.set(binding, `割り当てが重複しています: ${binding.mode}:${binding.from}`);
  }
  const checked = new Set<KeyBinding>();
  function validate(binding: KeyBinding, chain: Set<KeyBinding>): string | undefined {
    if (failures.has(binding)) return failures.get(binding);
    if (checked.has(binding)) return failures.get(binding);
    if (chain.has(binding)) return "循環するキー割り当てです。";
    if (/^(?:<Esc>|<C-\[>)$/i.test(binding.from)) return "EscとCtrl-[は取消操作専用です。";
    const next = new Set(chain).add(binding);
    const reason = validateSequence(binding.to, binding.mode, (remaining, mode) => {
      const dependency = bindings
        .filter((candidate) => candidate.mode === mode && remaining.startsWith(candidate.from))
        .sort((a, b) => a.from.length - b.from.length)[0];
      if (!dependency) return;
      const error = validate(dependency, next);
      return error
        ? { error: `参照先の割り当てが無効です: ${dependency.from} (${error})` }
        : dependency;
    });
    checked.add(binding);
    if (reason) failures.set(binding, reason);
    return reason;
  }
  for (const binding of bindings) {
    const reason = validate(binding, new Set());
    if (reason) failures.set(binding, reason);
  }
  return {
    active: bindings.filter((binding) => !failures.has(binding)),
    issues: [...failures].map(([binding, reason]) => ({ binding, reason })),
  };
}

function validateSequence(
  sequence: string,
  initialMode: VimMode,
  expand: (remaining: string, mode: VimMode) => KeyBinding | { error: string } | undefined,
): string | undefined {
  if (/[\r\n]/u.test(sequence)) return "キー列の改行には<CR>を指定してください。";
  const tokens = sequence.match(/<[^>]+>|./gu) ?? [];
  let mode = initialMode;
  // An initially Visual mapping and gv can start with any selection subtype.
  // Track known transitions without guessing which previous selection exists.
  let visualKind: SupportedCommand["visualKind"];
  let operator = mode === "operatorPending" ? "d" : "";
  let pending = "";
  let search = false;
  let ex: string | undefined;
  let surround = 0;
  let count = false;
  let expansionCount = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (ex !== undefined) {
      if (["<Esc>", "<C-[>", "<C-c>"].includes(token) || (token === "<BS>" && !ex)) {
        ex = undefined;
        continue;
      }
      if (token === "<CR>") {
        try {
          if (ex.trim()) {
            parseEx(ex);
            mode = "normal";
            visualKind = undefined;
          }
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        ex = undefined;
      } else if (token === "<C-u>") ex = "";
      else if (token === "<BS>") ex = [...ex].slice(0, -1).join("");
      else if (token === "<Space>") ex += " ";
      else if (token === "<lt>") ex += "<";
      else if ([...token].length === 1) ex += token;
      else return `Ex入力内では未対応のキーです: ${token}`;
      continue;
    }
    if (token === "<Esc>" || token === "<C-[>" || (token === "<C-c>" && mode !== "insert")) {
      mode = "normal";
      visualKind = undefined;
      operator = "";
      pending = "";
      search = false;
      surround = 0;
      count = false;
      continue;
    }
    if (search) {
      if (token === "<CR>") search = false;
      continue;
    }
    if (surround) {
      surround--;
      continue;
    }
    if (!pending) {
      const dependency = expand(tokens.slice(index).join(""), mode);
      if (dependency) {
        if ("error" in dependency) return dependency.error;
        if (++expansionCount > 1000) return "キー割り当ての展開が長すぎます。";
        const from = dependency.from.match(/<[^>]+>|./gu) ?? [];
        const to = dependency.to.match(/<[^>]+>|./gu) ?? [];
        tokens.splice(index, from.length, ...to);
        index--;
        continue;
      }
    }
    if (mode === "insert") {
      if ([...token].length === 1 || nativeInsertKeys.has(token)) continue;
      return `挿入モードでは未対応の操作です: ${token}`;
    }
    if (!pending && /^\d$/.test(token) && (count || token !== "0")) {
      count = true;
      continue;
    }
    count = false;
    if (!pending && ["c", "d", "y", "ys"].includes(operator) && token === "s") {
      if (operator === "c" || operator === "d") {
        surround = operator === "c" ? 2 : 1;
        operator = "";
        mode = "normal";
      } else if (operator === "y") operator = "ys";
      else if (operator === "ys") {
        surround = 1;
        operator = "";
        mode = "normal";
      }
      continue;
    }
    // Vim permits guu, gUU and g~~ as the shortened doubled operator.
    pending += !pending && operator.length > 1 && operator.at(-1) === token ? operator : token;
    const commands = SUPPORTED_COMMANDS.filter((entry) => entry.contexts.includes(mode));
    const exact = commands.find((entry) => entry.keys === pending);
    const literal = commands.find((entry) => {
      const prefix = entry.keys.replace(/<(character|register)>$/, "");
      return prefix !== entry.keys && pending.startsWith(prefix) && pending.length > prefix.length;
    });
    const extension = SUPPORTED_EXTENSION_KEYS.some((keys) => keys === pending);
    if (literal && !extension) {
      if (literal.keys.startsWith("i<") || literal.keys.startsWith("a<")) {
        if (!textObjects.has(pending.slice(1)))
          return `未対応のテキストオブジェクトです: ${pending}`;
        if (mode === "visual") {
          if (pending.slice(1) === "p") visualKind = "line";
          else if (pending.slice(1) === "s") visualKind = "character";
        }
      }
      if (/^[m'`]/.test(literal.keys) && !/^[m'`][a-z]$/.test(pending))
        return `小文字のローカルマークだけに対応しています: ${pending}`;
      pending = "";
      if (mode === "operatorPending") {
        mode = operator === "c" ? "insert" : "normal";
        if (operator === "ys") surround = 1;
        operator = "";
      } else if (literal.enters) mode = literal.enters;
      continue;
    }
    if (exact || extension) {
      const completed = pending;
      pending = "";
      if (completed === ":") ex = mode === "visual" ? "'<,'>" : "";
      else if (["/", "?"].includes(completed)) search = true;
      else if (exact?.operator) {
        if (mode === "visual") mode = exact.operator === "change" ? "insert" : "normal";
        else if (mode === "operatorPending") {
          if (completed !== operator)
            return `異なるoperatorは連続できません: ${operator}${completed}`;
          mode = operator === "c" ? "insert" : "normal";
          operator = "";
        } else {
          operator = completed;
          mode = "operatorPending";
        }
      } else if (completed === "gS") {
        surround = 1;
        mode = "normal";
      } else if (mode === "operatorPending") {
        mode = operator === "c" ? "insert" : "normal";
        if (operator === "ys") surround = 1;
        operator = "";
      } else if (exact?.enters === "visual") {
        if (exact.togglesVisual && mode === "visual" && visualKind === exact.visualKind) {
          mode = "normal";
          visualKind = undefined;
        } else {
          mode = "visual";
          visualKind = exact.visualKind;
        }
      } else if (exact?.enters) mode = exact.enters;
      continue;
    }
    const partial =
      commands.some((entry) => entry.keys.startsWith(pending)) ||
      SUPPORTED_EXTENSION_KEYS.some((keys) => keys.startsWith(pending));
    if (!partial) return `未対応の操作を含んでいます: ${pending}`;
  }
  if (ex?.trim()) {
    try {
      parseEx(ex);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
}

function extensionEnabled(name: string, settings: LindvimeraSettings): boolean {
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
  let bindings: KeyBinding[] = [];
  const policy: CommandPolicy = {
    allowsEx(command) {
      return ["move", "substitute", "delete", "yank", "put", "join", "sort", "nohlsearch"].includes(
        command.name,
      );
    },
    allows(command, context, keys) {
      const current = settings();
      if (previousBindings !== current.keyBindings) {
        previousBindings = current.keyBindings;
        bindings = analyseKeyBindings(current.keyBindings).active;
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
