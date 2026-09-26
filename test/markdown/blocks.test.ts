import { describe, expect, it } from "vitest";
import { indexMarkdownBlocks, markdownBlockObject } from "../../src/markdown/blocks";

function selected(text: string, at: number, kind: "h" | "L", inner = false, count = 1) {
  const range = markdownBlockObject(indexMarkdownBlocks(text), text.length, at, kind, inner, count);
  return range && { text: text.slice(range.from, range.to), linewise: range.linewise };
}

describe("Markdown section objects", () => {
  const text = "intro\n# Parent\n\nbody\n\n### Child\nchild\n\n# Next\nend";
  it("retains ATX and Setext levels separately from ancestor depth", () => {
    const source = "# One\n### Three\n##### Five\nTwo\n---\nOne again\n===";
    expect(
      indexMarkdownBlocks(source).sections.map(({ headingLevel, depth, parent }) => ({
        headingLevel,
        depth,
        parent,
      })),
    ).toEqual([
      { headingLevel: 1, depth: 0, parent: undefined },
      { headingLevel: 3, depth: 1, parent: 0 },
      { headingLevel: 5, depth: 2, parent: 1 },
      { headingLevel: 2, depth: 1, parent: 0 },
      { headingLevel: 1, depth: 0, parent: undefined },
    ]);
  });
  it("selects the nearest containing section and climbs real heading ancestors", () => {
    expect(selected(text, text.indexOf("child"), "h")).toEqual({
      text: "### Child\nchild\n\n",
      linewise: true,
    });
    expect(selected(text, text.indexOf("child"), "h", false, 2)).toEqual({
      text: "# Parent\n\nbody\n\n### Child\nchild\n\n",
      linewise: true,
    });
    expect(selected(text, text.indexOf("child"), "h", false, 3)).toBeUndefined();
    expect(selected(text, 1, "h")).toBeUndefined();
  });
  it("keeps descendant headings but omits its own heading and boundary blank lines", () => {
    expect(selected(text, text.indexOf("child"), "h", true, 2)).toEqual({
      text: "body\n\n### Child\nchild\n",
      linewise: true,
    });
  });
  it("recognizes multiline Setext headings and mixed heading levels", () => {
    const source = "Parent\n======\nfirst\n\nSecond line\nof title\n---\nbody\n# Last";
    expect(selected(source, source.indexOf("body"), "h", true)).toEqual({
      text: "body\n",
      linewise: true,
    });
    expect(selected(source, source.indexOf("body"), "h", false, 2)?.text).toBe(
      source.slice(0, source.indexOf("# Last")),
    );
  });
  it.each(["# Empty", "# Empty\n", "# Empty\n \n\n# Next\nbody"])(
    "has no inner range for an empty section in %s",
    (source) => {
      expect(selected(source, 0, "h", true)).toBeUndefined();
    },
  );
  it.each(["# Last\n日本語", "# Last\n日本語\n"])(
    "selects a final section at EOF in %s",
    (source) => {
      expect(selected(source, source.length, "h")?.text).toBe(source);
      expect(selected(source, source.length, "h", true)?.text).toBe(source.slice(7));
    },
  );
  it("excludes frontmatter, quoted/list headings, code, and HTML from section boundaries", () => {
    const source = [
      "---",
      "# yaml",
      "---",
      "# Real",
      "```md",
      "# fenced",
      "```",
      "",
      "    # indented",
      "> # quoted",
      "",
      "- # item heading",
      "",
      "<div>",
      "# html",
      "</div>",
      "",
      "# Next",
    ].join("\n");
    const blocks = indexMarkdownBlocks(source);
    expect(blocks.sections.map((section) => source.slice(section.from).split("\n")[0])).toEqual([
      "# Real",
      "# Next",
    ]);
    expect(selected(source, source.indexOf("# yaml"), "h")).toBeUndefined();
  });
  it("preserves offsets after non-ASCII frontmatter and ignores an unclosed frontmatter", () => {
    const source = "---\ntitle: 日本語👨‍👩‍👧‍👦\n...\n# Real\nbody";
    expect(selected(source, source.indexOf("body"), "h")?.text).toBe("# Real\nbody");
    expect(indexMarkdownBlocks("---\ntitle: note\n# not a heading").sections).toEqual([]);
  });
});

describe("Markdown list subtree objects", () => {
  it("preserves lazy continuation, separated paragraphs, descendants, and task markers", () => {
    const source = "1. [x] First\nlazy line\n\n   paragraph\n   - Nested\n\n2. Second";
    expect(selected(source, source.indexOf("First"), "L")?.text).toBe(
      source.slice(0, source.indexOf("2. Second")),
    );
    expect(selected(source, source.indexOf("First"), "L", true)).toEqual({
      text: "First\nlazy line\n\n   paragraph\n   - Nested",
      linewise: false,
    });
    expect(selected(source, source.indexOf("Nested"), "L")?.text).toBe("   - Nested\n\n");
    expect(selected(source, source.indexOf("Nested"), "L", false, 2)?.text).toBe(
      source.slice(0, source.indexOf("2. Second")),
    );
    expect(selected(source, source.indexOf("Nested"), "L", false, 3)).toBeUndefined();
  });
  it("retains ordered and checkbox prefixes when selecting inner content", () => {
    const source = "12) [X] 日本語 e\u0301👨‍👩‍👧‍👦\n13) next";
    expect(selected(source, 0, "L", true)?.text).toBe("日本語 e\u0301👨‍👩‍👧‍👦");
  });
  it.each([
    ["- first\n\n  [ ] later\n- next", "first\n\n  [ ] later"],
    ["- first\n  - child\n\n  [x] later\n- next", "first\n  - child\n\n  [x] later"],
  ])("keeps a later checkbox-like paragraph inside the item body in %s", (source, content) => {
    expect(selected(source, 2, "L", true)?.text).toBe(content);
  });
  it("distinguishes sibling indentation from code and thematic breaks", () => {
    const source =
      "    - code\n\n* * *\n\n> - quote\n\n- real\n\n  ```md\n  - fenced\n  ```\n\n- next";
    const blocks = indexMarkdownBlocks(source);
    expect(blocks.listItems).toHaveLength(2);
    expect(selected(source, source.indexOf("fenced"), "L")?.text).toBe(
      "- real\n\n  ```md\n  - fenced\n  ```\n\n",
    );
  });
  it("keeps a following non-list paragraph outside the item", () => {
    const source = "- item\n\nparagraph";
    expect(selected(source, 2, "L")?.text).toBe("- item\n\n");
    expect(selected(source, source.indexOf("paragraph"), "L")).toBeUndefined();
  });
  it.each(["-", "- ", "- [ ] "])("rejects the empty inner item %s", (source) => {
    expect(selected(source, 0, "L", true)).toBeUndefined();
  });
  it("uses the deepest item for adjacent nested markers on one line", () => {
    const source = "- - nested\n  - sibling";
    expect(selected(source, 0, "L", true)?.text).toBe("- nested\n  - sibling");
    expect(selected(source, source.indexOf("nested"), "L", true)?.text).toBe("nested");
    expect(selected(source, source.indexOf("nested"), "L", true, 2)?.text).toBe(
      "- nested\n  - sibling",
    );
  });
});
