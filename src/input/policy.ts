import type {
  CodeMirrorV,
  CommandPolicy,
  InputStateInterface,
  vimKey,
} from "@replit/codemirror-vim-core";
import type { KeyBinding, LindvimeraSettings, VimMode } from "../settings";

const movementModes: readonly VimMode[] = ["normal", "visual", "operatorPending"];
const selectionModes: readonly VimMode[] = ["normal", "visual"];

/** The finite public editing vocabulary. Literal arguments are checked separately. */
export const SUPPORTED_COMMANDS: readonly {
  keys: string;
  contexts: readonly VimMode[];
}[] = [
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
    "d",
    "c",
    "y",
    "=",
    ">",
    "<",
    "n",
    "N",
  ].map((keys) => ({ keys, contexts: movementModes })),
  ...[
    "x",
    "X",
    "D",
    "C",
    "Y",
    "s",
    "S",
    "p",
    "P",
    "J",
    "r<character>",
    "I",
    "A",
    "R",
    "v",
    "V",
    "<C-v>",
    "gv",
    "<C-r>",
    "zz",
    "zt",
    "zb",
    '"<register>',
    "<Del>",
    "<C-[>",
    "<C-c>",
    "/",
    "?",
    "*",
    "#",
  ].map((keys) => ({ keys, contexts: selectionModes })),
  ...["i", "a", "o", "O", "u", ".", "q<register>", "@<register>", "<CR>"].map((keys) => ({
    keys,
    contexts: ["normal"] as readonly VimMode[],
  })),
  ...["o", "O"].map((keys) => ({ keys, contexts: ["visual"] as readonly VimMode[] })),
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
const textObjects = new Set("wWbB()[]{}<>\"'`");
const supportedMotions = new Set([
  "moveToTopLine",
  "moveToMiddleLine",
  "moveToBottomLine",
  "moveByCharacters",
  "moveByLines",
  "moveByDisplayLines",
  "moveByWords",
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
  "textObjectManipulation",
]);
const supportedOperators = new Set(["delete", "change", "yank", "indent", "indentAuto"]);
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
  if (command.type === "ex" || command.type === "keyToEx") return false;
  if (command.type === "keyToKey") return !!builtinAliases[command.keys]?.includes(command.toKeys);
  if ("motion" in command && command.motion && !supportedMotions.has(command.motion)) return false;
  if ("operator" in command && command.operator && !supportedOperators.has(command.operator))
    return false;
  if ("action" in command && !supportedActions.has(command.action)) return false;
  if (command.type === "motion" && command.motion === "textObjectManipulation") {
    // Both partial candidates survive, but a complete unsupported object does not.
    return keys === command.keys || keys.length === 1 || textObjects.has(keys.slice(1));
  }
  if (command.keys === "@<register>" && keys === "@:") return false;
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
  const tokens = sequence.match(/<[^>]+>|./gu) ?? [];
  let mode = initialMode;
  let operator = mode === "operatorPending" ? "d" : "";
  let pending = "";
  let search = false;
  let surround = 0;
  let count = false;
  let expansionCount = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "<Esc>" || token === "<C-[>") {
      mode = "normal";
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
      if (token.length === 1 || nativeInsertKeys.has(token)) continue;
      return `挿入モードでは未対応の操作です: ${token}`;
    }
    if (!pending && /^\d$/.test(token) && (count || token !== "0")) {
      count = true;
      continue;
    }
    count = false;
    if (!pending && operator && token === "s") {
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
    pending += token;
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
      }
      if (pending === "@:") return "Exコマンドの再生には対応していません。";
      pending = "";
      if (mode === "operatorPending") {
        mode = operator === "c" ? "insert" : "normal";
        if (operator === "ys") surround = 1;
        operator = "";
      }
      continue;
    }
    if (exact || extension) {
      const completed = pending;
      pending = "";
      if (["/", "?"].includes(completed)) search = true;
      else if (
        ["i", "I", "a", "A", "o", "O", "R", "C", "s", "S"].includes(completed) &&
        !(mode === "visual" && ["o", "O"].includes(completed))
      )
        mode = "insert";
      else if (["d", "c", "y", "<", ">", "="].includes(completed)) {
        if (mode === "visual") mode = completed === "c" ? "insert" : "normal";
        else if (mode === "operatorPending") {
          mode = operator === "c" ? "insert" : "normal";
          operator = "";
        } else {
          operator = completed;
          mode = "operatorPending";
        }
      } else if (["v", "V", "<C-v>", "gv"].includes(completed)) mode = "visual";
      else if (completed === "gS") surround = 1;
      else if (mode === "operatorPending") {
        mode = operator === "c" ? "insert" : "normal";
        if (operator === "ys") surround = 1;
        operator = "";
      }
      continue;
    }
    const partial =
      commands.some((entry) => entry.keys.startsWith(pending)) ||
      SUPPORTED_EXTENSION_KEYS.some((keys) => keys.startsWith(pending));
    if (!partial) return `未対応の操作を含んでいます: ${pending}`;
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
