export type ExName =
  | "move"
  | "substitute"
  | "delete"
  | "yank"
  | "put"
  | "join"
  | "sort"
  | "nohlsearch";

export interface ExAddress {
  base: number | "." | "$" | { mark: string };
  offset: number;
}

export interface SubstituteSyntax {
  pattern: string;
  replacement: string;
  delimiter: string;
  allMatches: boolean;
  confirm: boolean;
  ignoreCase?: boolean;
}

export interface ExSyntax {
  input: string;
  name: ExName;
  range?: "%" | { from: ExAddress; to?: ExAddress };
  register?: string;
  substitution?: SubstituteSyntax;
  sort?: { reverse: boolean; ignoreCase: boolean; unique: boolean; numeric: boolean };
}

const commands: readonly [ExName, string][] = [
  ["substitute", "s"],
  ["delete", "d"],
  ["yank", "y"],
  ["put", "pu"],
  ["join", "j"],
  ["sort", "sor"],
  ["nohlsearch", "noh"],
];

/** The public Ex grammar. It reads no editor, register, history or search state. */
export function parseEx(input: string): ExSyntax {
  const source = input.replace(/^\s*:?\s*/u, "");
  let index = 0;
  const space = () => {
    while (/\s/u.test(source[index] ?? "") && index < source.length) index++;
  };
  const fail = (message: string): never => {
    throw new Error(message);
  };
  function address(): ExAddress | undefined {
    space();
    let base: ExAddress["base"];
    const number = /^\d+/u.exec(source.slice(index));
    if (number) {
      base = Number(number[0]);
      if (!Number.isSafeInteger(base) || base < 1) fail("行番号は1以上の整数で指定してください。");
      index += number[0].length;
    } else if (source[index] === "." || source[index] === "$") base = source[index++] as "." | "$";
    else if (source[index] === "'") {
      index++;
      const mark = source[index++] ?? "";
      if (!/^[a-z<>]$/u.test(mark)) fail("範囲には小文字マークかVisualマークを指定してください。");
      base = { mark };
    } else if (source[index] === "+" || source[index] === "-") base = ".";
    else return;
    let offset = 0;
    while (true) {
      space();
      const sign = source[index];
      if (sign !== "+" && sign !== "-") break;
      index++;
      space();
      const digits = /^\d+/u.exec(source.slice(index));
      const amount = digits ? Number(digits[0]) : 1;
      if (digits) index += digits[0].length;
      offset += sign === "+" ? amount : -amount;
      if (!Number.isSafeInteger(offset)) fail("行の移動量が大きすぎます。");
    }
    return { base, offset };
  }
  let range: ExSyntax["range"];
  if (source[index] === "%") {
    range = "%";
    index++;
  } else {
    const from = address();
    if (from) {
      range = { from };
      space();
      if (source[index] === ",") {
        index++;
        const to = address();
        if (!to) fail("範囲の終了行を指定してください。");
        range.to = to;
      }
    }
  }
  space();
  const nameMatch = /^[a-z]+/u.exec(source.slice(index));
  if (!nameMatch) {
    if (range && index === source.length) return { input, name: "move", range };
    return fail("未対応のExコマンドまたは範囲です。");
  }
  const abbreviation = nameMatch[0];
  index += abbreviation.length;
  const name = commands.find(
    ([full, short]) => abbreviation.length >= short.length && full.startsWith(abbreviation),
  )?.[0];
  if (!name) return fail(`未対応のExコマンドです: ${abbreviation}`);
  const result: ExSyntax = { input, name, range };
  if (name === "substitute") {
    space();
    if (index === source.length) return result;
    const delimiter = source[index++];
    if (/[A-Za-z0-9\s\\\uD800-\uDFFF]/u.test(delimiter)) fail("置換の区切り文字が不正です。");
    function token(requiredEnd: boolean): string {
      let value = "";
      while (index < source.length) {
        const character = source[index++];
        if (character === delimiter) return value;
        if (character === "\\" && index < source.length) {
          value += character + source[index++];
        } else value += character;
      }
      if (requiredEnd) fail("置換パターンの区切り文字が閉じていません。");
      return value;
    }
    const pattern = token(true);
    const replacement = token(false);
    const flags = source.slice(index).trim();
    if (!/^[gciI]*$/u.test(flags)) fail(`未対応の置換フラグです: ${flags}`);
    const caseFlag = [...flags].filter((flag) => flag === "i" || flag === "I").at(-1);
    result.substitution = {
      pattern,
      replacement,
      delimiter,
      allMatches: flags.includes("g"),
      confirm: flags.includes("c"),
      ignoreCase: caseFlag === undefined ? undefined : caseFlag === "i",
    };
    if (pattern) new RegExp(unescapePattern(pattern, delimiter));
  } else if (name === "sort") {
    const reverse = source[index] === "!";
    if (reverse) index++;
    const flags = source.slice(index).trim();
    if (!/^[iun]*$/u.test(flags)) fail(`未対応のsortオプションです: ${flags}`);
    result.sort = {
      reverse,
      ignoreCase: flags.includes("i"),
      unique: flags.includes("u"),
      numeric: flags.includes("n"),
    };
  } else if (name === "delete" || name === "yank" || name === "put") {
    const register = source.slice(index).trim();
    if (register && !/^[a-zA-Z0-9"_+.:/-]$/u.test(register))
      fail("レジスタを1文字で指定してください。");
    if (name !== "put" && /[.:/]/u.test(register))
      fail("読み取り専用のレジスタには書き込めません。");
    if (register) result.register = register;
  } else if (source.slice(index).trim()) fail("未対応のEx引数です。");
  if (name === "nohlsearch" && range) fail("nohlsearchには範囲を指定できません。");
  return result;
}

/** Preserve JS regex escapes, removing only the Ex delimiter's escape. */
export function unescapePattern(value: string, delimiter: string): string {
  return value.replace(/\\(.)/gsu, (pair: string, character: string) =>
    character === delimiter && !/[\^$.*+?()[\]{}|]/u.test(character) ? character : pair,
  );
}

/** Replacement escapes are distinct from capture expansion. */
export function unescapeReplacement(value: string, delimiter: string): string {
  return value.replace(/\\(.)/gsu, (pair: string, character: string) => {
    if (character === delimiter || character === "\\") return character;
    if (character === "n" || character === "r") return "\n";
    if (character === "t") return "\t";
    return pair;
  });
}

/** JS $1-$99 fallback rules; an existing, unmatched optional group is empty. */
export function expandReplacement(value: string, match: readonly (string | undefined)[]): string {
  return value.replace(/\$(\$|&|[1-9][0-9]?)/gu, (token: string, reference: string) => {
    if (reference === "$") return "$";
    if (reference === "&") return match[0] ?? "";
    const index = Number(reference);
    if (index < match.length) return match[index] ?? "";
    if (reference.length === 2 && Number(reference[0]) < match.length)
      return (match[Number(reference[0])] ?? "") + reference[1];
    return token;
  });
}
