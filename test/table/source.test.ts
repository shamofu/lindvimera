import { describe, expect, it } from "vitest";
import {
  decodeCell,
  displayToSource,
  encodeCell,
  parseMarkdownTable,
  sourceToDisplay,
  TableSourceError,
} from "../../src/table/source";

describe("native cell source maps", () => {
  it("maps pipe escapes and line breaks in both directions", () => {
    const map = decodeCell("a\\|b<br>c", 40);
    expect(map.text).toBe("a|b\nc");
    expect(map.boundaries).toEqual([40, 41, 43, 44, 48, 49]);
    for (let position = 0; position <= map.text.length; position++) {
      expect(sourceToDisplay(map, displayToSource(map, position))).toBe(position);
    }
    expect(sourceToDisplay(map, 46, -1)).toBe(3);
    expect(sourceToDisplay(map, 46, 1)).toBe(4);
    expect(() => displayToSource(map, -1)).toThrow(TableSourceError);
  });

  it("matches the native editor's code spans, wikilinks, and HTML conventions", () => {
    const source = "[[note\\|label]] `<br>` ``a<br>b`` <BR> <br/> &amp;";
    expect(decodeCell(source).text).toBe("[[note|label]] `<br>` ``a<br>b`` \n <br/> &amp;");
    expect(decodeCell(String.raw`a\\|b a\\\|b`).text).toBe(String.raw`a\\|b a\\|b`);
  });

  it("encodes newlines and pipes without adding duplicate escapes", () => {
    expect(encodeCell("left|right\r\nnext")).toBe("left\\|right<br>next");
    expect(encodeCell(String.raw`left\|right`)).toBe(String.raw`left\|right`);
    expect(encodeCell(String.raw`left\\|right`)).toBe(String.raw`left\\\|right`);
  });

  it("keeps UTF-16 offsets correct for emoji and combining marks", () => {
    const map = decodeCell("😀か\u3099\\|終", 10);
    expect(map.text).toBe("😀か\u3099|終");
    expect(displayToSource(map, 4)).toBe(14);
    expect(displayToSource(map, 5)).toBe(16);
  });
});

describe("exact table slices", () => {
  it("preserves absolute offsets, padding, header, and alignment row", () => {
    const source = "| Header | 日本語 |\n| :--- | ---: |\n| a\\|b |     |";
    const table = parseMarkdownTable(source, 100);
    expect(table.alignments).toEqual(["left", "right"]);
    expect(table.rows.length).toBe(2);
    expect(table.rows[0]![0]!.map.text).toBe("Header");
    expect(table.rows[1]![0]!.map.text).toBe("a|b");
    expect(table.rows[1]![1]!.map.text).toBe("");
    for (const row of table.rows) {
      for (const cell of row) {
        expect(source.slice(cell.content.from - 100, cell.content.to - 100)).toBe(cell.map.source);
      }
    }
    expect(source.slice(table.separator.from - 100, table.separator.to - 100)).toBe(
      "| :--- | ---: |",
    );
  });

  it("supports optional edge pipes and CRLF without shifting later offsets", () => {
    const source = "header | other\r\n:---: | ---\r\n[[a\\|alias]] | `x\\|y`\r\n";
    const table = parseMarkdownTable(source, 7);
    expect(table.alignments).toEqual(["center", null]);
    expect(table.rows[1]![0]!.map.text).toBe("[[a|alias]]");
    expect(table.rows[1]![1]!.map.text).toBe("`x|y`");
    expect(table.rows[1]![0]!.content.from).toBe(7 + source.indexOf("[["));
  });

  it("rejects malformed rows and does not treat code or wikilinks as escaped pipes", () => {
    expect(() => parseMarkdownTable("a | b\n--- | ---\nmissing")).toThrow(TableSourceError);
    expect(() => parseMarkdownTable("a | b\n--- | ---\n`a|b` | c")).toThrow(TableSourceError);
    expect(() => parseMarkdownTable("a | b\n--- | ---\n[[a|alias]] | c")).toThrow(TableSourceError);
    expect(() => parseMarkdownTable("a | b\ntext | text\n1 | 2")).toThrow(TableSourceError);
  });
});
