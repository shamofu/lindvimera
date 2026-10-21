import { describe, expect, it } from "vitest";
import {
  buildMarkdownEditingIndex,
  markdownContentStart,
  markdownOpenLine,
} from "../../src/markdown/editing";

function open(source: string, at: number, after: boolean) {
  const edit = markdownOpenLine(buildMarkdownEditingIndex(source), at, after);
  if (!edit) return;
  let text = source;
  for (const change of [...edit.changes].reverse())
    text = text.slice(0, change.from) + change.insert + text.slice(change.to);
  expect(edit.changes.every((change, i) => i === 0 || edit.changes[i - 1].to <= change.from)).toBe(
    true,
  );
  return { text, cursor: edit.cursor };
}

describe("Markdown content starts", () => {
  it.each([
    ["- [x] 日本語", 6],
    ["  + [X] task", 8],
    ["> > 12) [ ] body", 12],
    ["- > ## title", 7],
    ["> ## heading", 5],
    ["### heading", 4],
    ["- - child", 4],
    ["- ", 2],
    [">", 1],
    ["> - [ ] ", 8],
    ["> [!note] Title", 2],
    ["plain", 0],
    ["  plain", 2],
  ] as const)("finds content in %s", (source, expected) => {
    expect(markdownContentStart(buildMarkdownEditingIndex(source), source.length)).toBe(expected);
  });
  it("uses UTF-16 offsets in a later row", () => {
    const source = "日本👩‍💻\n> - [x] é🦊";
    expect(markdownContentStart(buildMarkdownEditingIndex(source), source.length)).toBe(16);
  });
});

describe("Markdown physical row insertion", () => {
  it.each([
    ["- first", true, "- first\n- ", 10],
    ["+ first", false, "+ \n+ first", 2],
    ["  * [X] task", true, "  * [X] task\n  * [ ] ", 21],
    ["> > - [x] task", true, "> > - [x] task\n> > - [ ] ", 25],
    ["> [!note] Title", true, "> [!note] Title\n> ", 18],
    ["- ", true, "- \n- ", 5],
    [">", true, ">\n> ", 4],
    ["> - [ ] ", false, "> - [ ] \n> - [ ] ", 8],
    ["> ## heading", true, "> ## heading\n> ", 15],
    ["- > ## heading", true, "- > ## heading\n- > ", 19],
  ] as const)("opens a prefixed row beside %s", (source, after, text, cursor) => {
    expect(open(source, 0, after)).toEqual({ text, cursor });
  });
  it("inserts below the current physical row before descendants", () => {
    expect(open("- parent\n  - child\n- next", 3, true)).toEqual({
      text: "- parent\n- \n  - child\n- next",
      cursor: 11,
    });
  });
  it("continues markerless list rows with indentation only", () => {
    expect(open("- first\n  continued\n- next", 13, true)).toEqual({
      text: "- first\n  continued\n  \n- next",
      cursor: 22,
    });
    expect(open("> - first\n>   continued", 17, false)).toEqual({
      text: "> - first\n>   \n>   continued",
      cursor: 14,
    });
  });
  it("uses standard fallback for ordinary rows and headings", () => {
    for (const source of ["plain", "  plain", "### heading", ""]) {
      expect(markdownOpenLine(buildMarkdownEditingIndex(source), 0, true)).toBeUndefined();
    }
  });
});

describe("ordered list insertion", () => {
  it.each([
    ["3. first\n9. next", 0, true, "3. first\n4. \n5. next", 12],
    ["3) first\n9) next", 0, false, "3) \n4) first\n5) next", 3],
    ["3. first\n9. middle\n20. last", 12, true, "3. first\n9. middle\n10. \n11. last", 23],
    ["3. first\n9. last", 12, true, "3. first\n9. last\n10. ", 21],
    ["> 7) [x] first\n> 20) next", 5, true, "> 7) [x] first\n> 8) [ ] \n> 9) next", 24],
  ] as const)("renumbers siblings for %s", (source, at, after, text, cursor) => {
    expect(open(source, at, after)).toEqual({ text, cursor });
  });
  it("adjusts descendant and continuation indentation when O widens 9 to 10", () => {
    const source = "9. parent\n   continuation\n   7. child\n      body\n10. next";
    expect(open(source, 0, false)).toEqual({
      text: "9. \n10. parent\n    continuation\n    7. child\n       body\n11. next",
      cursor: 3,
    });
  });
  it("keeps children numbered independently and stops at another list", () => {
    const source = "1. parent\n   4. child\n   8. sibling\n9. next\n\nparagraph\n\n20. separate";
    expect(open(source, 0, true)).toEqual({
      text: "1. parent\n2. \n   4. child\n   8. sibling\n3. next\n\nparagraph\n\n20. separate",
      cursor: 13,
    });
  });
  it("keeps Unicode text and final cursor offsets intact", () => {
    expect(open("🦊\n\n9. 日本", 8, true)).toEqual({ text: "🦊\n\n9. 日本\n10. ", cursor: 14 });
  });
});

describe("literal block exclusions", () => {
  it.each([
    ["```md\n- fake\n```", "- fake"],
    ["> ```\n> - fake\n> ```", "- fake"],
    ["- ```\n  - fake\n  ```", "- fake"],
    ["    - code", "- code"],
    [">     - code", "- code"],
    ["- parent\n\n      - code", "- code"],
    ["---\ntitle: 日本🦊\n- yaml\n---", "- yaml"],
    ["---\n- yaml", "- yaml"],
    ["a | b\n-- | --\nx | y", "x | y"],
    ["> a | b\n> -- | --\n> x | y", "x | y"],
  ] as const)("defers code, frontmatter or table row in %s", (source, needle) => {
    const index = buildMarkdownEditingIndex(source);
    const at = source.indexOf(needle);
    expect(markdownContentStart(index, at)).toBeUndefined();
    expect(markdownOpenLine(index, at, true)).toBeUndefined();
    expect(markdownOpenLine(index, at, false)).toBeUndefined();
  });
});

describe("structural numbering edge cases", () => {
  it("normalizes leading-zero numbers without leaving old digits in the new prefix", () => {
    expect(open("009. first\n010. next", 0, true)).toEqual({
      text: "009. first\n10. \n11. next",
      cursor: 15,
    });
  });
  it("retains quoted descendant indentation while widening a numbered parent", () => {
    expect(open("> 9. parent\n>    - child\n>      body\n> 10. next", 3, false)).toEqual({
      text: "> 9. \n> 10. parent\n>     - child\n>       body\n> 11. next",
      cursor: 5,
    });
  });
  it("keeps nested list and quote prefixes on the same physical row", () => {
    expect(open("- > 2) [x] body\n  > 8) next", 11, true)).toEqual({
      text: "- > 2) [x] body\n  > 3) [ ] \n  > 4) next",
      cursor: 27,
    });
  });
  it("preserves the relative indentation of descendants after narrowing sibling digits", () => {
    expect(open("1. first\n10. second\n    continued\n    - child", 0, true)).toEqual({
      text: "1. first\n2. \n3. second\n   continued\n   - child",
      cursor: 12,
    });
  });
  it("does not mistake paragraph interruption or thematic rules for list prefixes", () => {
    for (const source of ["paragraph\n9. text", "---", "* * *", "+not a list"]) {
      const at = source.indexOf("9.") < 0 ? 0 : source.indexOf("9.");
      expect(markdownOpenLine(buildMarkdownEditingIndex(source), at, true)).toBeUndefined();
    }
  });
});

describe("change-plan coordinates", () => {
  it("keeps renumbering changes in the original source coordinate system", () => {
    const source = "9. parent\n   body\n10. next";
    expect(markdownOpenLine(buildMarkdownEditingIndex(source), 0, false)).toEqual({
      changes: [
        { from: 0, to: 0, insert: "9. \n" },
        { from: 0, to: 1, insert: "10" },
        { from: 10, to: 10, insert: " " },
        { from: 18, to: 20, insert: "11" },
      ],
      cursor: 3,
    });
  });
  it("keeps repeated calls against the same index independent", () => {
    const index = buildMarkdownEditingIndex("1. first\n2. next");
    expect(markdownOpenLine(index, 0, true)).toEqual(markdownOpenLine(index, 0, true));
    expect(index.text).toBe("1. first\n2. next");
  });
  it("adjusts tab-indented descendants when a parent grows", () => {
    expect(open("9. parent\n\t- child\n10. next", 0, false)).toEqual({
      text: "9. \n10. parent\n\t - child\n11. next",
      cursor: 3,
    });
  });
});

describe("heading and nested container boundaries", () => {
  it("skips indentation and ATX marks but keeps opening heading rows on Vim fallback", () => {
    const index = buildMarkdownEditingIndex("  ### title");
    expect(markdownContentStart(index, 7)).toBe(6);
    expect(markdownOpenLine(index, 7, false)).toBeUndefined();
  });
  it("copies only quote indentation from an indented quote heading", () => {
    expect(open("  >  ## title", 9, false)).toEqual({
      text: "  >  \n  >  ## title",
      cursor: 5,
    });
  });
  it("copies a list marker but omits its heading prefix", () => {
    expect(open("  - ## title", 8, true)).toEqual({
      text: "  - ## title\n  - ",
      cursor: 17,
    });
  });
  it("continues markerless list heading rows with indentation alone", () => {
    expect(open("- parent\n  ## title\n- next", 14, true)).toEqual({
      text: "- parent\n  ## title\n  \n- next",
      cursor: 22,
    });
  });
  it("widens a numbered parent before a descendant quote without adding a list marker", () => {
    expect(open("9. > quote\n   > body\n10. next", 5, false)).toEqual({
      text: "9. > \n10. > quote\n    > body\n11. next",
      cursor: 5,
    });
  });
  it("adjusts tab descendants relative to an existing quote prefix", () => {
    expect(open("> 9. parent\n>   \t- child\n> 10. next", 4, false)).toEqual({
      text: "> 9. \n> 10. parent\n>   \t - child\n> 11. next",
      cursor: 5,
    });
  });
  it("defers every fence and table boundary row, including nested delimiters", () => {
    for (const source of ["- ```md\n  - code\n  ```", "> a | b\n> -- | --\n> x | y"]) {
      const index = buildMarkdownEditingIndex(source);
      for (const at of [0, source.indexOf("\n") + 1, source.lastIndexOf("\n") + 1]) {
        expect(markdownContentStart(index, at)).toBeUndefined();
        expect(markdownOpenLine(index, at, true)).toBeUndefined();
      }
    }
  });
  it("ends YAML masking at a Unicode-offset-preserving terminator", () => {
    const source = "---\ntitle: 🦊\n...\n> ## title";
    const index = buildMarkdownEditingIndex(source);
    expect(markdownContentStart(index, 15)).toBeUndefined();
    expect(markdownContentStart(index, source.length)).toBe(23);
    expect(open(source, source.length, true)).toEqual({
      text: "---\ntitle: 🦊\n...\n> ## title\n> ",
      cursor: 31,
    });
  });
});

it("keeps deeply nested continuation contexts inside their containing list", () => {
  const source = "- parent\n  - child\n    ## nested\n\noutside";
  expect(open(source, 28, true)).toEqual({
    text: "- parent\n  - child\n    ## nested\n    \n\noutside",
    cursor: 37,
  });
  const index = buildMarkdownEditingIndex(source);
  expect(markdownOpenLine(index, source.length, true)).toBeUndefined();
});

describe("inline nested marker hierarchy", () => {
  it("opens a nested ordered sibling by indenting ancestor markers", () => {
    const result = open("1. 9. child\n   10. next", 8, true);
    expect(result).toEqual({
      text: "1. 9. child\n   10. \n   11. next",
      cursor: 19,
    });
    expect(buildMarkdownEditingIndex(result!.text).tree.toString()).toBe(
      "Document(OrderedList(ListItem(ListMark,OrderedList(ListItem(ListMark,Paragraph),ListItem(ListMark),ListItem(ListMark,Paragraph)))))",
    );
  });
  it("transfers the ancestor marker above the original row for O", () => {
    const source = "1. 9. child\n   10. next";
    expect(open(source, 8, false)).toEqual({
      text: "1. 9. \n   10. child\n   11. next",
      cursor: 6,
    });
    expect(markdownOpenLine(buildMarkdownEditingIndex(source), 8, false)).toEqual({
      changes: [
        { from: 0, to: 0, insert: "1. 9. \n" },
        { from: 0, to: 3, insert: "   " },
        { from: 3, to: 4, insert: "10" },
        { from: 15, to: 17, insert: "11" },
      ],
      cursor: 6,
    });
  });
  it("keeps nested bullet insertion on the same parsed list", () => {
    expect(open("- - child\n  - next", 5, true)).toEqual({
      text: "- - child\n  - \n  - next",
      cursor: 14,
    });
    expect(open("- - child\n  - next", 5, false)).toEqual({
      text: "- - \n  - child\n  - next",
      cursor: 4,
    });
  });
  it("retains intermediate quotes when transferring an ancestor list prefix", () => {
    expect(open("- > 9) child\n  > 10) next", 8, false)).toEqual({
      text: "- > 9) \n  > 10) child\n  > 11) next",
      cursor: 7,
    });
  });
});

describe("effective list padding during width changes", () => {
  it("uses one column of padding before code indented by excess spaces", () => {
    expect(open("8. first\n9.     code\n   continuation\n   - child\n10. next", 3, true)).toEqual({
      text: "8. first\n9. \n10.     code\n    continuation\n    - child\n11. next",
      cursor: 12,
    });
  });
  it("uses visual tab columns to recognize excess post-marker padding", () => {
    expect(open("8. first\n9.\t\tcode\n   - child\n10. next", 3, true)).toEqual({
      text: "8. first\n9. \n10.      code\n    - child\n11. next",
      cursor: 12,
    });
  });
  it("adjusts descendants that now belong to a newly widened marker below the physical row", () => {
    expect(open("9. parent\n   - child\n10. next", 3, true)).toEqual({
      text: "9. parent\n10. \n    - child\n11. next",
      cursor: 14,
    });
  });
  it("keeps deep inline quote descendants aligned below a newly widened marker", () => {
    expect(open("- > 9) parent\n  >    4. child\n  >       body\n  > 10) next", 8, true)).toEqual({
      text: "- > 9) parent\n  > 10) \n  >     4. child\n  >        body\n  > 11) next",
      cursor: 22,
    });
  });
});

describe("post-marker tabs during numbered width changes", () => {
  it("keeps excess padding as indented code when renumbering crosses a tab stop", () => {
    const result = open("8. first\n9.\t   code\n   - child\n10. next", 3, true);
    expect(result).toEqual({
      text: "8. first\n9. \n10.     code\n    - child\n11. next",
      cursor: 12,
    });
    expect(buildMarkdownEditingIndex(result!.text).tree.toString()).toBe(
      "Document(OrderedList(ListItem(ListMark,Paragraph),ListItem(ListMark),ListItem(ListMark,CodeBlock(CodeText),BulletList(ListItem(ListMark,Paragraph))),ListItem(ListMark,Paragraph)))",
    );
  });
  it("preserves original visual padding in a newly widened prefix", () => {
    expect(open("9.\tparent\n    - child\n10. next", 5, true)).toEqual({
      text: "9.\tparent\n10.  \n     - child\n11. next",
      cursor: 15,
    });
  });
  it("normalizes the existing marker padding for O and keeps equal-width inserted tabs", () => {
    expect(open("9.\tparent\n    - child\n10. next", 5, false)).toEqual({
      text: "9.\t\n10.  parent\n     - child\n11. next",
      cursor: 3,
    });
  });
});
