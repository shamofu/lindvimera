import { describe, expect, it } from "vitest";
import { internalLinkAt } from "../../src/markdown/links";

describe("Internal links from the current Markdown source", () => {
  it.each([
    ["[[Folder/Note]]", "Folder/Note"],
    ["[[Folder/Note|Alias]]", "Folder/Note"],
    ["[[Note#Heading|Alias]]", "Note#Heading"],
    ["[[Note#^block-id]]", "Note#^block-id"],
    ["[[#Same note heading]]", "#Same note heading"],
    ["[[Literal%20name#Heading%20text|Alias]]", "Literal%20name#Heading%20text"],
    ["[Alias](Folder/Note.md#Heading)", "Folder/Note.md#Heading"],
    ["[Alias](Folder/My%20Note.md#%5Eblock)", "Folder/My Note.md#^block"],
    ['[Alias](<Folder/My Note.md#Heading> "title")', "Folder/My Note.md#Heading"],
    ['[Alias](Note.md "title")', "Note.md"],
    ["[Alias](Note\\(draft\\).md)", "Note(draft).md"],
    ["[Alias](Note(draft).md)", "Note(draft).md"],
    ["[Alias](50%note.md)", "50%note.md"],
  ])("resolves %s", (text, target) => {
    expect(internalLinkAt(text, 3)).toBe(target);
    expect(internalLinkAt(text, text.length - 1)).toBe(target);
    expect(internalLinkAt(text, text.length)).toBeUndefined();
  });

  it.each([
    "[Alias](https://example.com)",
    "[Alias](mailto:user@example.com)",
    "[Alias](obsidian://open?file=Note)",
    "[Alias](//example.com/path)",
    "`[[fake]]`",
    "``[[fake]] ` more``",
    "```md\n[[fake]]\n```",
    "~~~md\n[[fake]]\n~~~",
    "    [[fake]]",
    "---\nname: [[fake]]\n---",
    "\\[[fake]]",
  ])("does not open external links or code in %s", (text) => {
    expect(internalLinkAt(text, Math.max(text.indexOf("fake"), 3))).toBeUndefined();
  });

  it("recognizes a real link after inline code and links in list items", () => {
    const text = "- `[[fake]]` [[Real|alias]]";
    expect(internalLinkAt(text, text.indexOf("alias"))).toBe("Real");
  });

  it("supports embeds and ignores offsets outside the enclosing link", () => {
    const text = "before ![[Note#^block]] after";
    expect(internalLinkAt(text, text.indexOf("!"))).toBe("Note#^block");
    expect(internalLinkAt(text, 0)).toBeUndefined();
    expect(internalLinkAt(text, text.length - 1)).toBeUndefined();
  });
});
