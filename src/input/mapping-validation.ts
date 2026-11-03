import type { KeyBinding, LindvimeraSettings, VimMode } from "../settings";
import { SUPPORTED_COMMANDS, SUPPORTED_EXTENSIONS, type SupportedCommand } from "./commands";

interface MappingLanguage {
  strict?: boolean;
  parseEx?(input: string, pcre: boolean): { name: string; pcre?: boolean };
  validateBinding?(binding: KeyBinding): string | undefined;
}

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
export const textObjects = new Set("wWspbB()[]{}<>\"'`");
export interface KeyBindingIssue {
  binding: KeyBinding;
  reason: string;
}

/** Keep saved definitions intact and disable only invalid definitions/dependents. */
export function analyseMappings(
  bindings: readonly KeyBinding[],
  settings?: LindvimeraSettings,
  language: MappingLanguage = {},
): {
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
    const structural = language.validateBinding?.(binding);
    if (structural) failures.set(binding, structural);
    if (failures.has(binding)) return failures.get(binding);
    if (checked.has(binding)) return failures.get(binding);
    if (chain.has(binding)) return "循環するキー割り当てです。";
    if (/^(?:<Esc>|<C-\[>)$/i.test(binding.from)) return "EscとCtrl-[は取消操作専用です。";
    const next = new Set(chain).add(binding);
    const reason = validateSequence(
      binding.to,
      binding.mode,
      (remaining, mode) => {
        const dependency = bindings
          .filter((candidate) => candidate.mode === mode && remaining.startsWith(candidate.from))
          .sort((a, b) => a.from.length - b.from.length)[0];
        if (!dependency) return;
        const error = validate(dependency, next);
        return error
          ? { error: `参照先の割り当てが無効です: ${dependency.from} (${error})` }
          : dependency;
      },
      settings,
      language,
    );
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
    issues: bindings
      .filter((binding) => failures.has(binding))
      .map((binding) => ({ binding, reason: failures.get(binding)! })),
  };
}

function validateSequence(
  sequence: string,
  initialMode: VimMode,
  expand: (remaining: string, mode: VimMode) => KeyBinding | { error: string } | undefined,
  settings: LindvimeraSettings | undefined,
  language: MappingLanguage,
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
  let pcre = true;
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
            const command: { name: string; pcre?: boolean } | undefined = language.parseEx?.(
              ex,
              pcre,
            );
            if (command?.name === "set") pcre = command.pcre!;
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
      if (language.strict) return `挿入モードでは未対応の操作です: ${token}`;
      continue;
    }
    if (!pending && /^\d$/.test(token) && (count || token !== "0")) {
      count = true;
      continue;
    }
    count = false;
    if (!pending && ["c", "d", "y", "ys"].includes(operator) && token === "s") {
      if (settings && !settings.surround) return "Surroundが設定で無効です。";
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
    // Vim permits guu, gUU, g~~ and g?? as shortened doubled operators.
    pending += !pending && operator.length > 1 && operator.at(-1) === token ? operator : token;
    const commands = SUPPORTED_COMMANDS.filter((entry) => entry.contexts.includes(mode));
    const exact = commands.find((entry) => entry.keys === pending);
    const literal = commands.find((entry) => {
      const prefix = entry.keys.replace(/<(character|register)>$/, "");
      return prefix !== entry.keys && pending.startsWith(prefix) && pending.length > prefix.length;
    });
    const extensionCandidate = SUPPORTED_EXTENSIONS.find(
      (entry) => entry.keys === pending && entry.contexts.includes(mode),
    );
    // Markdown backticks override Vim's quote object only while enabled. Keep
    // mappings to the native object usable when that extension is switched off.
    const nativeObject =
      literal && /^[ia]<register>$/.test(literal.keys) && textObjects.has(pending.slice(1));
    const extension =
      nativeObject &&
      extensionCandidate?.feature &&
      settings &&
      !settings[extensionCandidate.feature]
        ? undefined
        : extensionCandidate;
    if (literal && !extension) {
      if (literal.keys.startsWith("i<") || literal.keys.startsWith("a<")) {
        if (language.strict && !textObjects.has(pending.slice(1)))
          return `未対応のテキストオブジェクトです: ${pending}`;
        if (mode === "visual") {
          if (pending.slice(1) === "p") visualKind = "line";
          else if (pending.slice(1) === "s") visualKind = "character";
        }
      }
      if (language.strict && /^[m'`]/.test(literal.keys) && !/^[m'`][a-z]$/.test(pending))
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
      if (extension?.feature && settings && !settings[extension.feature])
        return `対応する機能が設定で無効です: ${extension.keys}`;
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
      } else if (extension?.feature === "folding") {
        mode = "normal";
        visualKind = undefined;
      } else if (mode === "operatorPending") {
        mode = operator === "c" ? "insert" : "normal";
        if (operator === "ys") surround = 1;
        operator = "";
      } else if (mode === "visual" && ["ih", "ah", "aL", "iL"].includes(completed)) {
        visualKind = completed === "iL" ? "character" : "line";
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
      SUPPORTED_EXTENSIONS.some(
        (entry) => entry.contexts.includes(mode) && entry.keys.startsWith(pending),
      );
    if (!partial) {
      if (language.strict) return `未対応の操作を含んでいます: ${pending}`;
      // Unknown native commands belong to the host; do not impose the bundled allowlist.
      pending = "";
    }
  }
  if (ex?.trim()) {
    try {
      language.parseEx?.(ex, pcre);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
}
