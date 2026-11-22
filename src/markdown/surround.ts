import { indexMarkdown, type TextRange } from "./ranges";

export interface SurroundPair {
  left: string;
  right: string;
}

export interface SurroundRange {
  outer: TextRange;
  inner: TextRange;
}

export interface SurroundEdit {
  from: number;
  to: number;
  insert: string;
  cursor: number;
}

const aliases: Record<string, string> = { b: ")", B: "}", r: "]", a: ">" };
const pairs: Record<string, [string, string]> = {
  "(": ["(", ")"],
  ")": ["(", ")"],
  "[": ["[", "]"],
  "]": ["[", "]"],
  "{": ["{", "}"],
  "}": ["{", "}"],
  "<": ["<", ">"],
  ">": ["<", ">"],
};

export function surroundPair(key: string): SurroundPair | undefined {
  key = aliases[key] ?? key;
  if ([...key].length !== 1 || /\s/.test(key)) return;
  const pair = pairs[key];
  if (pair) {
    const space = "([{<".includes(key) ? " " : "";
    return { left: pair[0] + space, right: space + pair[1] };
  }
  return { left: key, right: key };
}

export function surroundText(text: string, key: string): string {
  const pair = surroundPair(key);
  return pair ? pair.left + text + pair.right : text;
}

function escaped(text: string, at: number): boolean {
  let backslashes = 0;
  while (at > 0 && text[--at] === "\\") backslashes++;
  return backslashes % 2 === 1;
}

/** Counts select enclosing pairs; a Markdown delimiter run is one syntax unit. */
export function findSurround(
  text: string,
  offset: number,
  target: string,
  count = 1,
): SurroundRange | undefined {
  target = aliases[target] ?? target;
  const pair = pairs[target];
  const matches: SurroundRange[] = [];
  count = Math.max(1, count);
  if (pair) {
    const stack: number[] = [];
    for (let at = 0; at < text.length; at++) {
      if (escaped(text, at)) continue;
      if (text[at] === pair[0]) stack.push(at);
      if (text[at] === pair[1] && stack.length) {
        const start = stack.pop()!;
        if (start <= offset && offset <= at)
          matches.push({ outer: { from: start, to: at + 1 }, inner: { from: start + 1, to: at } });
      }
    }
    matches.sort((a, b) => a.outer.to - a.outer.from - (b.outer.to - b.outer.from));
    const match = matches[count - 1];
    if (match && "([{<".includes(target)) {
      while (match.inner.from < match.inner.to && /\s/.test(text[match.inner.from]))
        match.inner.from++;
      while (match.inner.to > match.inner.from && /\s/.test(text[match.inner.to - 1]))
        match.inner.to--;
    }
    return match;
  }
  if ([...target].length !== 1) return;
  if (target === "*" || target === "_" || target === "`") {
    const candidates = indexMarkdown(text)
      .objects.filter(
        (object) => object.kind === target && object.from <= offset && offset < object.to,
      )
      .sort((a, b) => a.to - a.from - (b.to - b.from));
    const match = candidates[count - 1];
    if (!match) return;
    let width = 1;
    while (text[match.from + width] === target) width++;
    return {
      outer: { from: match.from, to: match.to },
      inner: { from: match.from + width, to: match.to - width },
    };
  }
  const runs: { at: number; width: number }[] = [];
  for (let at = 0; at < text.length; at++) {
    if (text[at] !== target || escaped(text, at)) continue;
    let width = 1;
    while (text[at + width] === target) width++;
    runs.push({ at, width });
    at += width - 1;
  }
  for (let i = 0; i + 1 < runs.length; i += 2) {
    const left = runs[i];
    const right = runs[i + 1];
    if (left.at <= offset && right.at + right.width > offset && left.width === right.width) {
      matches.push({
        outer: { from: left.at, to: right.at + right.width },
        inner: { from: left.at + left.width, to: right.at },
      });
    }
  }
  return matches[count - 1];
}

export function addSurroundEdit(
  text: string,
  from: number,
  to: number,
  replacement: string,
  linewise = false,
): SurroundEdit | undefined {
  if (!replacement) return undefined;
  let start = Math.max(0, Math.min(from, to));
  let end = Math.min(text.length, Math.max(from, to));
  let content = text.slice(start, end);
  if (linewise) {
    // yss surrounds line contents while retaining indentation and the final newline.
    const leading = /^\s*/u.exec(content)![0].length;
    const trailing = /\s*$/u.exec(content)![0].length;
    start += leading;
    end = Math.max(start, end - trailing);
    content = text.slice(start, end);
  }
  return { from: start, to: end, insert: surroundText(content, replacement), cursor: start };
}

export function changeSurroundEdit(
  text: string,
  offset: number,
  target: string,
  replacement?: string,
  count = 1,
  precomputed?: SurroundRange,
): SurroundEdit | undefined {
  const range = precomputed ?? findSurround(text, offset, target, count);
  if (!range) return undefined;
  const content = text.slice(range.inner.from, range.inner.to);
  return {
    from: range.outer.from,
    to: range.outer.to,
    insert: replacement ? surroundText(content, replacement) : content,
    cursor: range.outer.from,
  };
}

/** Apply a surrounding edit to one editing target. */
export function changeSurround(
  text: string,
  offset: number,
  target: string,
  replacement?: string,
  count = 1,
): { text: string; cursor: number } | undefined {
  const edit = changeSurroundEdit(text, offset, target, replacement, count);
  if (!edit) return;
  return {
    text: text.slice(0, edit.from) + edit.insert + text.slice(edit.to),
    cursor: edit.cursor,
  };
}
