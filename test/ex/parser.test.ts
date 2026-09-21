import { describe, expect, it } from "vitest";
import {
  expandReplacement,
  parseEx,
  unescapePattern,
  unescapeReplacement,
} from "../../src/ex/parser";

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
    "set pcre",
    "map Q dd",
    "global/x/d",
    "normal dd",
    "write",
    "tabnext",
    "/find/delete",
    "?find?y",
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
