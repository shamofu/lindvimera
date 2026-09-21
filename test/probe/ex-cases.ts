import type { EditorView } from "@codemirror/view";

/** The same Ex edits run against Source, Live Preview, and native cell buffers. */
export const exEditingCases: readonly {
  text: string;
  command: string;
  result: string;
  before?: string;
  register?: { name: string; text: string };
}[] = [
  {
    text: "alpha1 alpha2\nalpha3\nomega",
    command: "1,2s/(alpha)([0-9])/$2-$1/g",
    result: "1-alpha 2-alpha\n3-alpha\nomega",
  },
  { text: "ALPHA alpha", command: "s/alpha/X/gi", result: "X X" },
  { text: "ALPHA alpha", command: "s/alpha/X/gI", result: "ALPHA X" },
  { text: "a1b2\nc3", command: "%s/[0-9]//g", result: "ab\nc" },
  {
    text: "one\ntwo\nthree",
    command: "1,2delete a",
    result: "three",
    register: { name: "a", text: "one\ntwo\n" },
  },
  { text: "one\ntwo\nthree", command: ".+1,$d", result: "one" },
  { text: "one\ntwo", before: '"ayiw', command: "1put a", result: "one\none\ntwo" },
  { text: "one\ntwo\nthree", command: "%join", result: "one two three" },
  { text: "Beta\nalpha\nBeta\nalpha", command: "%sort! iu", result: "Beta\nalpha" },
  { text: "2\n10\n1\n2", command: "%sort! nu", result: "10\n2\n1" },
  { text: "one\ntwo\nthree", before: "2Gma", command: "'a,$d", result: "one" },
  { text: "one\none\nlast", before: "Vj", command: "'<,'>s/one/X/g", result: "X\nX\nlast" },
];

export function submitEx(surface: EditorView, command: string): void {
  surface.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: ":",
      code: "Semicolon",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  const input = surface.dom.querySelector<HTMLInputElement>(".cm-vim-panel input");
  if (!input) throw new Error(`Ex input did not open for :${command}`);
  input.value = command;
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
}

export function answerEx(panel: HTMLElement | null | undefined, key: string): void {
  const input = panel?.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error(`No replacement confirmation input for ${key}`);
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key === "Escape" ? "Escape" : `Key${key.toUpperCase()}`,
      keyCode: key === "Escape" ? 27 : key.toUpperCase().charCodeAt(0),
      bubbles: true,
      cancelable: true,
    }),
  );
}
