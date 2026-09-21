/** Shared real-host cases, exercised through DOM input in the body and native cells. */
export const extendedEditingCases = [
  { keys: "dap", text: "one\nnext\n\nlast", result: "last" },
  { keys: "d_", text: "one\ntwo\nthree", result: "two\nthree" },
  { keys: "d+", text: "one\ntwo\nthree", result: "three" },
  { keys: "dis", text: "今日は晴れです。明日は雨です。", result: "明日は雨です。" },
  { keys: "Visd", text: "今日は晴れです。明日は雨です。", result: "明日は雨です。" },
  { keys: "gUiw", text: "one two", result: "ONE two" },
  { keys: "guu", text: "ONE TWO", result: "one two" },
  { keys: "g~~", text: "AbC", result: "aBc" },
  { keys: "vllU", text: "one two", result: "ONE two" },
  { keys: "gJ", text: "one\n  two", result: "one  two" },
  { keys: "g*gnU", text: "one one", result: "one ONE" },
] as const;
