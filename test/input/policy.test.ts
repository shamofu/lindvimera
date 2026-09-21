import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { dispatchVimKeyEvent, getCM, skipVimKeyEvent, vim, Vim } from "@replit/codemirror-vim";
import type { CodeMirrorV } from "@replit/codemirror-vim-core";
import { analyseKeyBindings, installCommandPolicy } from "../../src/input/policy";
import { DEFAULT_SETTINGS, loadSettings, type KeyBinding } from "../../src/settings";

const views: EditorView[] = [];
function editor(text = "alpha beta gamma") {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: text, extensions: [history(), vim()] }),
  });
  views.push(view);
  const cm = getCM(view)!;
  const rejected: string[] = [];
  const settings = { ...DEFAULT_SETTINGS, keyBindings: [] as KeyBinding[] };
  const remove = installCommandPolicy(
    cm as CodeMirrorV,
    () => settings,
    (message) => rejected.push(message),
  );
  return { view, cm, rejected, settings, remove };
}
function keys(cm: ReturnType<typeof editor>["cm"], sequence: string) {
  for (const key of sequence.match(/<[^>]+>|./gu) ?? [])
    cm.operation(() => Vim.handleKey(cm, key, "user"));
}
function event(key: string, options: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
}
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
beforeEach(() => Vim.resetVimGlobalState_());
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("per-editor supported editing policy", () => {
  it("filters unsupported complete and partial commands without affecting another editor", () => {
    const a = editor();
    const b = editor();
    b.remove();
    keys(a.cm, "m");
    expect(a.cm.state.vim!.marks.a).toBeUndefined();
    keys(b.cm, "ma");
    expect(b.cm.state.vim!.marks.a).toBeDefined();
    expect(dispatchVimKeyEvent(a.cm, event(":"))).toBe("handled");
    expect(a.cm.state.dialog).toBeTruthy();
    expect(a.cm.state.vim!.inputState.keyBuffer).toEqual([]);
  });
  it("preserves literal characters and rejects unsupported objects", () => {
    const { cm, view } = editor("alpha: (beta) tail");
    keys(cm, "f:");
    expect(cm.getCursor().ch).toBe(5);
    keys(cm, "0di(");
    expect(view.state.doc.toString()).toBe("alpha: () tail");
    keys(cm, "dat");
    expect(view.state.doc.toString()).toBe("alpha: () tail");
    expect(cm.state.vim!.inputState.operator).toBeFalsy();
  });
  it("caches unhandled events as well as handled events", () => {
    const { cm } = editor();
    const move = event("l");
    expect(dispatchVimKeyEvent(cm, move)).toBe("handled");
    expect(dispatchVimKeyEvent(cm, move)).toBe("handled");
    expect(cm.getCursor().ch).toBe(1);
    const unknown = event("m");
    expect(dispatchVimKeyEvent(cm, unknown)).toBe("unhandled");
    keys(cm, "f");
    expect(dispatchVimKeyEvent(cm, unknown)).toBe("unhandled");
    expect(cm.state.vim!.inputState.keyBuffer).toEqual(["f"]);
  });
  it("lets host-owned and composing input bypass the later adapter handler", () => {
    const { cm, view } = editor();
    keys(cm, "i");
    const escape = event("Escape");
    skipVimKeyEvent(cm, escape);
    view.contentDOM.dispatchEvent(escape);
    expect(cm.state.vim!.insertMode).toBe(true);
    expect(dispatchVimKeyEvent(cm, event("Escape", { isComposing: true }))).toBe("native");
    expect(cm.state.vim!.insertMode).toBe(true);
    expect(dispatchVimKeyEvent(cm, event("Escape"))).toBe("handled");
    expect(cm.state.vim!.insertMode).toBe(false);
  });
  it("preserves native clipboard keys in Insert and Replace", () => {
    const { cm, view } = editor();
    keys(cm, "R");
    cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 3 });
    expect(dispatchVimKeyEvent(cm, event("c", { ctrlKey: true }))).toBe("native");
    expect(cm.state.vim!.insertMode).toBe(true);
    expect(view.state.doc.toString()).toBe("alpha beta gamma");
  });
  it("cancels pending operator/count/register without leaving Visual", () => {
    const { cm } = editor();
    keys(cm, '"a2d');
    Vim.cancelPendingInput(cm);
    expect(cm.state.vim!.inputState.operator).toBeFalsy();
    expect(cm.state.vim!.inputState.registerName).toBeFalsy();
    expect(cm.state.vim!.inputState.getRepeat()).toBe(0);
    keys(cm, "v");
    Vim.cancelPendingInput(cm);
    expect(cm.state.vim!.visualMode).toBe(true);
  });
  it("ends an invalid pending sequence without executing its final key elsewhere", () => {
    const { cm, view } = editor();
    keys(cm, "d");
    expect(dispatchVimKeyEvent(cm, event("m"))).toBe("handled");
    expect(cm.state.vim!.inputState.operator).toBeFalsy();
    expect(view.state.doc.toString()).toBe("alpha beta gamma");
  });
  it("stops macro replay once at unsupported operations and preserves completed edits for Undo", () => {
    const { cm, view, rejected } = editor();
    Vim.getRegisterController().getRegister("a").setText("xmbl");
    keys(cm, "2@a");
    expect(view.state.doc.toString()).toBe("lpha beta gamma");
    expect(cm.getCursor().ch).toBe(0);
    expect(rejected).toHaveLength(1);
    keys(cm, "u");
    expect(view.state.doc.toString()).toBe("alpha beta gamma");
  });
  it("blocks a stale unsupported dot edit and Ex without an editing provider", () => {
    const { cm, view, rejected, remove } = editor();
    remove();
    keys(cm, "g?iw");
    expect(view.state.doc.toString()).toBe("nycun beta gamma");
    installCommandPolicy(
      cm as CodeMirrorV,
      () => DEFAULT_SETTINGS,
      (message) => rejected.push(message),
    );
    keys(cm, ".");
    expect(view.state.doc.toString()).toBe("nycun beta gamma");
    expect(rejected).toHaveLength(1);
    Vim.handleEx(cm as CodeMirrorV, "%delete");
    expect(view.state.doc.toString()).toBe("nycun beta gamma");
  });
});

describe("mapping migration", () => {
  it.each([
    ":%s/😀/x/g<CR>@:",
    "Vj:delete a<CR>",
    ":1,$sort! iu<CR>",
    ":s<CR>",
    ":s/a/b/c<CR>~",
    ":<Esc>i:<Esc>",
    ":d<BS>y<CR>",
    ":<BS>sfoo<Esc>",
    ":<BS>i<CR><Esc>",
  ])("accepts validated Ex input and transitions in %s", (to) => {
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to }]).issues).toEqual([]);
  });
  it("keeps the mode for an empty Ex command and completes the automatic Visual range", () => {
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to: "v:<C-u><CR>U" }]).issues).toEqual(
      [],
    );
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to: "v:<CR>U" }]).issues).toHaveLength(
      1,
    );
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to: "v:<BS>U" }]).issues).toHaveLength(
      1,
    );
  });
  it("retains Visual mode when Backspace cancels an emptied Ex prompt", () => {
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to: "v:<C-u><BS>U" }]).issues).toEqual(
      [],
    );
  });
  it.each([
    ":global/x/d<CR>",
    ":normal x<CR>",
    ":write<CR>",
    ":s/a/b/e<CR>",
    ":delete|yank<CR>",
    ":/x/delete<CR>",
    ":s/(/x/<CR>",
  ])("rejects unsupported Ex syntax in %s", (to) => {
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to }]).issues).toHaveLength(1);
  });
  it.each(["magg'a", "magg`a", "3<C-o>2<C-i>"])("accepts local navigation in %s", (to) => {
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to }]).issues).toEqual([]);
  });
  it.each(["mA", "'A", "`A", "d'a", "v`a", "vmz"])("rejects unsupported mark scope in %s", (to) => {
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to }]).issues).toHaveLength(1);
  });
  it.each(["v<C-c>U", "c<C-c>:write<CR>"])(
    "does not treat cancellation as Visual or Insert in %s",
    (to) => {
      expect(analyseKeyBindings([{ mode: "normal", from: "Q", to }]).issues).toHaveLength(1);
    },
  );
  it.each(["vvU", "VVU", "<C-v><C-v>U", "vipVU", "VisvU", "vgS)U"])(
    "rejects Visual-only commands after returning to Normal in %s",
    (to) => {
      expect(analyseKeyBindings([{ mode: "normal", from: "Q", to }]).issues).toHaveLength(1);
    },
  );
  it.each([
    "vviX<Esc>",
    "VViX<Esc>",
    "<C-v><C-v>iX<Esc>",
    "vVU",
    "VvU",
    "v<C-v>U",
    "vipViX<Esc>",
    "VisviX<Esc>",
    "gNgS)iX<Esc>",
  ])("tracks Visual subtypes and completed surrounds in %s", (to) => {
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to }]).issues).toEqual([]);
  });
  it.each(["gUsw", "gUdw", "gugUw", "dcw"])("rejects mismatched operators in %s", (to) => {
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to }]).issues).toHaveLength(1);
  });
  it.each([
    "gUiw",
    "guu",
    "gUU",
    "g~~",
    "2gU2w",
    "vipU",
    "visu",
    "dap",
    "cisnew<Esc>",
    "gnU",
    "cgnnew<Esc>.",
    "gNdiw",
    "vlgU",
    "gJ",
    "2+_2-",
    "g*gnU",
    "v~iX<Esc>",
    "vrXiY<Esc>",
    "dg*",
    "cg#X<Esc>",
  ])("accepts extended editing and mode transitions in %s", (to) => {
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to }]).issues).toEqual([]);
  });
  it("resolves mappings after search-selection and case operators in the resulting mode", () => {
    const definitions: KeyBinding[] = [
      { mode: "normal", from: "Q", to: "gnZ" },
      { mode: "visual", from: "Z", to: "U" },
      { mode: "normal", from: "K", to: "guwZ" },
      { mode: "normal", from: "Z", to: ":unsupported<CR>" },
    ];
    expect(analyseKeyBindings(definitions).active).toEqual(definitions.slice(0, 2));
  });
  it("retains unsupported saved definitions while disabling only them and dependents", () => {
    const good: KeyBinding = { mode: "normal", from: "Q", to: "dw" };
    const bad: KeyBinding = { mode: "normal", from: "Z", to: ":write<CR>" };
    const dependent: KeyBinding = { mode: "normal", from: "K", to: "Z" };
    const saved = loadSettings({ keyBindings: [good, bad, dependent, { mode: "bad" }] });
    expect(saved.keyBindings).toEqual([good, bad, dependent]);
    expect(analyseKeyBindings(saved.keyBindings).active).toEqual([good]);
    expect(analyseKeyBindings(saved.keyBindings).issues).toHaveLength(2);
  });
  it.each([
    "f:",
    "r:",
    "i:text<CR><Esc>",
    "ciw:text<Esc>",
    'ysiw"',
    "cs\"'",
    '"adw',
    '"a10d2w',
    "c10wreplacement<Esc>0p",
    'yss"',
    "vldw",
    "ciw:colon<Esc>f:",
  ])("accepts literal arguments in %s", (to) => {
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to }]).issues).toEqual([]);
  });
  it("locks cancellation keys and rejects cyclic definitions independently", () => {
    const definitions: KeyBinding[] = [
      { mode: "normal", from: "<Esc>", to: "x" },
      { mode: "normal", from: "Z", to: "Q" },
      { mode: "normal", from: "Q", to: "Z" },
      { mode: "normal", from: "j", to: "gj" },
    ];
    expect(analyseKeyBindings(definitions).active).toEqual([definitions[3]]);
  });
  it("disables duplicate definitions and their dependents while retaining the saved rows", () => {
    const definitions: KeyBinding[] = [
      { mode: "normal", from: "Q", to: "dw" },
      { mode: "normal", from: "Q", to: "x" },
      { mode: "normal", from: "Z", to: "Q" },
      { mode: "normal", from: "j", to: "gj" },
    ];
    const saved = loadSettings({ keyBindings: definitions });
    expect(saved.keyBindings).toEqual(definitions);
    expect(analyseKeyBindings(saved.keyBindings).active).toEqual([definitions[3]]);
    expect(analyseKeyBindings(saved.keyBindings).issues).toHaveLength(3);
  });
  it.each(["di*", "da_", "diC", "dil", "ci*replacement<Esc>"])(
    "accepts Markdown object mapping %s",
    (to) => {
      expect(analyseKeyBindings([{ mode: "normal", from: "Q", to }]).issues).toEqual([]);
    },
  );
  it("keeps Visual endpoint swaps in Visual when checking following commands", () => {
    expect(analyseKeyBindings([{ mode: "normal", from: "Q", to: "vo:delete<CR>" }]).issues).toEqual(
      [],
    );
    expect(analyseKeyBindings([{ mode: "visual", from: "Q", to: "o:delete<CR>" }]).issues).toEqual(
      [],
    );
    expect(analyseKeyBindings([{ mode: "visual", from: "Q", to: "O:delete<CR>" }]).issues).toEqual(
      [],
    );
    expect(analyseKeyBindings([{ mode: "visual", from: "Q", to: "oI:<Esc>" }]).issues).toEqual([]);
  });
  it("expands embedded mappings in their current mode but leaves literal arguments intact", () => {
    const definitions: KeyBinding[] = [
      { mode: "normal", from: "Z", to: "i" },
      { mode: "normal", from: "Q", to: "Zliteral:<Esc>f:" },
      { mode: "normal", from: "K", to: ":unsupported<CR>" },
      { mode: "normal", from: "H", to: "fK" },
      { mode: "normal", from: "L", to: "wK" },
    ];
    expect(analyseKeyBindings(definitions).active).toEqual(
      definitions.slice(0, 2).concat(definitions[3]),
    );
  });
  it("runs a valid mapping but guards a subsequently changed replay target", () => {
    const { cm, settings, view } = editor();
    settings.keyBindings = [{ mode: "normal", from: "Q", to: "dw" }];
    Vim.map("Q", "dw", "normal");
    keys(cm, "Q");
    expect(view.state.doc.toString()).toBe("beta gamma");
  });
});
