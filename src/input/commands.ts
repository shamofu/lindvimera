import type { VimMode } from "../settings";

const movementModes: readonly VimMode[] = ["normal", "visual", "operatorPending"];
const selectionModes: readonly VimMode[] = ["normal", "visual"];
export const operatorCommands = {
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

export interface SupportedCommand {
  keys: string;
  feature?: "markdownMotions" | "textObjects" | "surround" | "tables" | "folding";
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

export const SUPPORTED_EXTENSIONS: readonly SupportedCommand[] = [
  { keys: "gf", contexts: ["normal"], feature: undefined },
  ...["[h", "]h", "[l", "]l"].map((keys) => ({
    keys,
    contexts: movementModes,
    feature: "markdownMotions" as const,
  })),
  ...["i*", "a*", "i_", "a_", "i\x60", "a\x60", "il", "al", "iC", "aC", "ih", "ah", "iL", "aL"].map(
    (keys) => ({
      keys,
      contexts: ["visual", "operatorPending"] as readonly VimMode[],
      feature: "textObjects" as const,
    }),
  ),
  ...["ys", "ds", "cs"].map((keys) => ({
    keys,
    contexts: ["normal"] as readonly VimMode[],
    feature: "surround" as const,
  })),
  { keys: "gS", contexts: ["visual"], feature: "surround" },
  ...["<Tab>", "<S-Tab>", "[t", "]t"].map((keys) => ({
    keys,
    contexts: ["normal"] as readonly VimMode[],
    feature: "tables" as const,
  })),
  ...["zo", "zc", "zO", "zC"].map((keys) => ({
    keys,
    contexts: selectionModes,
    enters: "normal" as const,
    feature: "folding" as const,
  })),
  ...["za", "zA", "zR", "zM"].map((keys) => ({
    keys,
    contexts: ["normal"] as readonly VimMode[],
    feature: "folding" as const,
  })),
];
export const SUPPORTED_EXTENSION_KEYS = SUPPORTED_EXTENSIONS.map((entry) => entry.keys);
