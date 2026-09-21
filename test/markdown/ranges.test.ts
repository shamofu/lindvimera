import { describe, expect, it } from "vitest";
import { indexMarkdown, markdownObject, structureMotion } from "../../src/markdown/ranges";
import { changeSurround, findSurround, surroundText } from "../../src/markdown/surround";

describe("Markdown syntax ranges", () => {
  it("skips frontmatter and fenced/indented code for structural navigation", () => {
    const text =
      "---\n# yaml\n---\nstart\n~~~md\n# fake\n- fake\n~~~\n    # indented\n# real\nSetext\n===\n";
    const index = indexMarkdown(text);
    expect(index.headings.map((entry) => text.slice(entry.position).split("\n")[0])).toEqual([
      "real",
      "Setext",
    ]);
    expect(index.lists).toEqual([]);
  });
  it("never stays on the current heading/list when positioned in its prefix", () => {
    const text = "# first\n# second\n- first\n- second";
    const index = indexMarkdown(text);
    expect(structureMotion(index, text, 0, "heading", true)).toBe(text.indexOf("second"));
    expect(structureMotion(index, text, text.indexOf("- first"), "list", true)).toBe(
      text.lastIndexOf("second"),
    );
  });
  it.each([
    ["***bold italic***", "*", "*bold italic*"],
    ["**multi\nline**", "*", "multi\nline"],
    ["`**literal**` **real**", "*", "real"],
    ["``a ` b``", "`", "a ` b"],
    ["[title](url(with-parens))", "l", "title"],
    ["[[Page|Alias]]", "l", "Page|Alias"],
  ] as const)("finds the correct inner range in %s", (text, kind, expected) => {
    const at =
      kind === "l"
        ? 3
        : kind === "*" && text.includes("real")
          ? text.indexOf("real")
          : Math.floor(text.length / 2);
    const range = markdownObject(indexMarkdown(text), at, kind, true)!;
    expect(text.slice(range.from, range.to)).toBe(expected);
  });
  it("does not treat escaped delimiters and intraword underscores as formatting", () => {
    const text = "snake_case_value \\*not italic\\*";
    expect(indexMarkdown(text).objects).toEqual([]);
  });
  it("selects link destinations when the cursor is inside the URL", () => {
    const text = "[label](path(file))";
    const range = markdownObject(indexMarkdown(text), text.indexOf("file"), "l", true)!;
    expect(text.slice(range.from, range.to)).toBe("path(file)");
  });
  it("handles empty and unclosed code blocks without returning inverted ranges", () => {
    for (const text of ["```\n```", "```ts", "```\nunfinished"]) {
      const range = markdownObject(indexMarkdown(text), 1, "C", true)!;
      expect(range.from).toBeLessThanOrEqual(range.to);
      expect(range.to).toBeLessThanOrEqual(text.length);
    }
  });
});

describe("Surround text transformations used by body and tables", () => {
  it("keeps nesting and multiline content", () => {
    const text = "outer(one\n(two))";
    const range = findSurround(text, text.indexOf("two"), ")", 2)!;
    expect(text.slice(range.inner.from, range.inner.to)).toBe("one\n(two)");
    expect(changeSurround(text, text.indexOf("two"), ")", "]", 2)?.text).toBe("outer[one\n(two)]");
  });
  it("treats Markdown runs as syntax units and counts enclosing syntax pairs", () => {
    expect(changeSurround("**word**", 3, "*")?.text).toBe("word");
    expect(changeSurround("**word**", 3, "*", undefined, 2)).toBeUndefined();
    expect(changeSurround("**outer *word* rest**", 10, "*", undefined, 2)?.text).toBe(
      "outer *word* rest",
    );
    expect(changeSurround("``a ` b``", 4, "`")?.text).toBe("a ` b");
    expect(changeSurround("`**word**`", 4, "*")).toBeUndefined();
    expect(changeSurround("~~word~~", 4, "~")?.text).toBe("word");
  });
  it("handles aliases and safely preserves text on unknown key notation", () => {
    expect(surroundText("word", "b")).toBe("(word)");
    expect(surroundText("word", "~")).toBe("~word~");
    expect(surroundText("word", "<Esc>")).toBe("word");
  });
});
