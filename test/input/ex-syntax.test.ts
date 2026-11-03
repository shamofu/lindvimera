import { describe, expect, it } from "vitest";
import {
  expandReplacement,
  parseEx,
  unescapePattern,
  unescapeReplacement,
} from "../../src/input/ex-syntax";

describe("bounded Ex syntax", () => {
  it.each([
    ["s/a/b/", "substitute"],
    ["substitute/a/b/", "substitute"],
    ["d", "delete"],
    ["del", "delete"],
    ["delete a", "delete"],
    ["y A", "yank"],
    ["pu a", "put"],
    ["put", "put"],
    ["j", "join"],
    ["join", "join"],
    ["sor! iun", "sort"],
    ["sort", "sort"],
    ["noh", "nohlsearch"],
    ["nohlsearch", "nohlsearch"],
    ["42", "move"],
    ["set nopcre", "set"],
    ["set pcre", "set"],
  ])("resolves %s to %s", (input, name) => {
    expect(parseEx(input).name).toBe(name);
  });

  it("keeps ranges structural until an editor resolves them", () => {
    expect(parseEx(":'a+2,$-1delete a")).toMatchObject({
      range: { from: { base: { mark: "a" }, offset: 2 }, to: { base: "$", offset: -1 } },
      register: "a",
    });
    expect(parseEx("'<,'>y").range).toEqual({
      from: { base: { mark: "<" }, offset: 0 },
      to: { base: { mark: ">" }, offset: 0 },
    });
    expect(parseEx("+2,-d").range).toEqual({
      from: { base: ".", offset: 2 },
      to: { base: ".", offset: -1 },
    });
    expect(parseEx("%sort").range).toBe("%");
  });

  it("preserves empty replacements, alternate delimiters and the final case flag", () => {
    expect(parseEx("s#one\\#two##ggiIIc").substitution).toEqual({
      pattern: "one\\#two",
      replacement: "",
      delimiter: "#",
      allMatches: true,
      confirm: true,
      ignoreCase: false,
    });
    expect(parseEx("s|a|x|Ii").substitution?.ignoreCase).toBe(true);
    expect(parseEx("s/a/space ").substitution?.replacement).toBe("space ");
    expect(parseEx("s").substitution).toBeUndefined();
    expect(parseEx("s//x/").substitution?.pattern).toBe("");
  });

  it.each([
    "set number",
    "map Q dd",
    "global/x/d",
    "normal dd",
    "write",
    "tabnext",
    "/find",
    "?find",
    "1;2d",
    "1,d",
    "0d",
    "'Ad",
    "%noh",
    "d a b",
    "d 12",
    "d :",
    "s/foo",
    "s/[a/b/",
    "s/a/b/e",
    "s/a/b/g 2",
    "s/a/b/|delete",
    "sort x",
    "sort /p/",
    "put! a",
    "join!",
    "delete|yank",
    "s😀a😀b😀",
    "substitutex/a/b/",
    "99999999999999999999d",
  ])("rejects unsupported or malformed %s", (input) => {
    expect(() => parseEx(input)).toThrow();
  });
});

it("parses forward, backward and reused search addresses with offsets", () => {
  expect(parseEx(String.raw`:/foo\/bar/+1,?end?-2d`).range).toEqual({
    from: { base: { search: String.raw`foo\/bar`, delimiter: "/" }, offset: 1 },
    to: { base: { search: "end", delimiter: "?" }, offset: -2 },
  });
  expect(parseEx("//y").range).toMatchObject({ from: { base: { search: "" } } });
});

it("defers Vim pattern validation to a pure supplied translator", () => {
  expect(() => parseEx("s/(/x/", { pcre: false })).not.toThrow();
  expect(() =>
    parseEx(String.raw`s/\(/x/`, {
      pcre: false,
      translateVimPattern: (pattern) => pattern.replaceAll(String.raw`\(`, "("),
    }),
  ).toThrow();
});

describe("JavaScript substitution strings", () => {
  it("unescapes delimiters without changing regex metacharacters", () => {
    expect(unescapePattern("a\\/b", "/")).toBe("a/b");
    expect(unescapePattern("a\\#b", "#")).toBe("a#b");
    expect(unescapePattern("\\.", ".")).toBe("\\.");
    expect(unescapePattern("\\|", "|")).toBe("\\|");
    expect(unescapeReplacement("x\\#y\\n\\t\\\\z", "#")).toBe("x#y\n\t\\z");
  });

  it.each(["$1", "$2", "$12", "$20", "$99", "$100", "$$", "$&", "$$$1", "$$1", "$0"])(
    "expands %s like native JavaScript, including unmatched optional groups",
    (replacement) => {
      const match = /(a)(b)?/u.exec("a")!;
      expect(expandReplacement(replacement, match)).toBe("a".replace(/(a)(b)?/u, replacement));
    },
  );

  it("supports capture 99 and appends digits beyond the supported two-digit number", () => {
    const match = Array.from({ length: 100 }, (_, index) => `${index}`);
    expect(expandReplacement("$99:$100", match)).toBe("99:100");
  });
});
