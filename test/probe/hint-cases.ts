import { Transaction } from "@codemirror/state";
import { undoDepth } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { editorSession, getCM, Vim } from "./runtime";

interface HintCaseOptions {
  /** The caller owns saved settings and restores them after this disposable suite. */
  setHintsEnabled?(enabled: boolean): Promise<void>;
}

const source = "# Heading\nalpha beta\n- first\n  - child\n# Next\nlast";
const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Use the host's DOM input route, including scope priority and mode refresh. */
function physical(view: EditorView, sequence: string): void {
  for (const token of sequence.match(/<[^>]+>|./gu) ?? []) {
    const control = /^<C-(.)>$/.exec(token);
    const key = control?.[1] ?? (token === "<Esc>" ? "Escape" : token);
    const code =
      key === "Escape" ? "Escape" : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : "";
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code,
        keyCode: key === "Escape" ? 27 : key.toUpperCase().charCodeAt(0),
        ctrlKey: !!control,
        shiftKey: !control && /^[A-Z]$/.test(key),
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}

function overlay(view: EditorView): HTMLElement | null {
  return view.dom.querySelector<HTMLElement>(".lindvimera-pending-hints");
}

async function visible(view: EditorView, description: string): Promise<HTMLElement> {
  const deadline = Date.now() + 3000;
  while (!overlay(view) && Date.now() < deadline) await pause(20);
  const found = overlay(view);
  assert(found, `No pending-key hints appeared for ${description}.`);
  assert(found.getClientRects().length, `The ${description} hint overlay is not visible.`);
  return found;
}

function snapshot(view: EditorView): string {
  const state = getCM(view)!.state.vim!;
  const input = state.inputState;
  return JSON.stringify({
    document: view.state.doc.toString(),
    selection: view.state.selection.toJSON(),
    undo: undoDepth(view.state),
    register: Vim.getRegisterController().getRegister('"').toString(),
    operator: input.operator,
    keyBuffer: input.keyBuffer,
    prefixRepeat: input.prefixRepeat,
    motionRepeat: input.motionRepeat,
    registerName: input.registerName,
    literal: state.expectLiteralNext,
  });
}

/** Source and Live Preview share the production runtime and a passive eight-row overlay. */
export async function runHintCases(view: EditorView, options: HintCaseOptions = {}): Promise<void> {
  assert(editorSession(view), "The pending-hint suite needs the production editor session.");
  if (options.setHintsEnabled) await options.setHintsEnabled(true);
  physical(view, "<Esc>");
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: source },
    selection: { anchor: 0 },
    annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
  });
  view.focus();
  await pause(180);
  const initialDepth = undoDepth(view.state);
  const focused = view.dom.ownerDocument.activeElement;
  try {
    const started = performance.now();
    physical(view, "d");
    const pendingDelete = snapshot(view);
    assert(!overlay(view), "Pending hints appeared without the 500ms delay.");
    await pause(300);
    // A slow host may resume this check after the timer already became due.
    if (performance.now() - started < 490)
      assert(!overlay(view), "Pending hints appeared before the configured delay.");
    const deletion = await visible(view, "d");
    assert(
      performance.now() - started >= 490,
      "Pending hints appeared before 500ms (10ms tolerance).",
    );
    assert(
      deletion.querySelectorAll("kbd").length === 8,
      "The d hint list was not capped at eight rows.",
    );
    assert(deletion.textContent?.includes("ほか"), "The d hint list omitted its overflow count.");
    assert(
      snapshot(view) === pendingDelete,
      "Rendering hints changed the pending command or editor state.",
    );
    assert(view.dom.ownerDocument.activeElement === focused, "Pending hints stole editor focus.");
    assert(
      !deletion.querySelector("button, input, select, [tabindex]"),
      "Pending hints added interactive controls.",
    );

    physical(view, "i");
    assert(!overlay(view), "Typing the next key left stale d candidates visible.");
    const objects = await visible(view, "di");
    const objectKeys = [...objects.querySelectorAll("kbd")].map((entry) => entry.textContent);
    assert(
      objectKeys.includes("h") && objectKeys.includes("L"),
      "di omitted the heading/list objects.",
    );
    assert(objectKeys.length <= 8, "The object hint list exceeded eight rows.");
    physical(view, "<Esc>");
    assert(!overlay(view), "Escape did not immediately dismiss hints.");
    await pause(550);
    assert(!overlay(view), "A cancelled timer reopened pending hints.");

    physical(view, "g");
    const g = await visible(view, "g");
    assert(
      [...g.querySelectorAll("kbd")].some((entry) => entry.textContent === "f"),
      "g omitted the internal-link continuation.",
    );
    assert(g.querySelectorAll("kbd").length <= 8, "The g hint list exceeded eight rows.");
    physical(view, "<Esc>z");
    const z = await visible(view, "z");
    const foldKeys = [...z.querySelectorAll("kbd")].map((entry) => entry.textContent);
    assert(
      foldKeys.includes("o") && foldKeys.includes("c"),
      "z omitted the open/close fold commands.",
    );
    physical(view, "<Esc>i");
    assert(getCM(view)!.state.vim!.insertMode, "The hint suite failed to enter Insert.");
    await pause(550);
    assert(!overlay(view), "Hints stayed visible in Insert mode.");
    assert(
      view.dom.ownerDocument.activeElement === focused,
      "Entering Insert after hints lost editor focus.",
    );
    physical(view, "<Esc>vi");
    const visual = await visible(view, "Visual i");
    assert(getCM(view)!.state.vim!.visualMode, "Visual hints changed the selection mode.");
    assert(
      [...visual.querySelectorAll("kbd")].some((entry) => entry.textContent === "h"),
      "Visual i omitted the heading object.",
    );
    physical(view, "<Esc>");

    physical(view, "g");
    await visible(view, "g before IME");
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    assert(!overlay(view), "Starting IME composition did not dismiss hints.");
    await pause(550);
    assert(!overlay(view), "Hints reopened during IME composition.");
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await pause(180);
    physical(view, "<Esc>");

    physical(view, "/");
    const dialog = getCM(view)!.state.dialog;
    assert(dialog, "The search dialog did not open through DOM input.");
    await pause(550);
    assert(!overlay(view), "Hints appeared over the search dialog.");
    const search = dialog.querySelector("input");
    assert(search, "The search dialog has no input.");
    search.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        bubbles: true,
        cancelable: true,
      }),
    );
    await pause(180);
    assert(!getCM(view)!.state.dialog, "Search cancellation left its dialog open.");
    view.focus();

    physical(view, "qag");
    assert(Vim.getVimGlobalState_().macroModeState.isRecording, "Macro recording did not begin.");
    await pause(550);
    assert(!overlay(view), "Hints appeared while recording a macro.");
    physical(view, "<Esc>q");
    assert(!Vim.getVimGlobalState_().macroModeState.isRecording, "Macro recording did not stop.");

    physical(view, "g");
    await visible(view, "g before focus leaves");
    view.contentDOM.blur();
    assert(!overlay(view), "Moving focus out of the editor left hints visible.");
    view.focus();
    physical(view, "<Esc>");

    if (options.setHintsEnabled) {
      await options.setHintsEnabled(false);
      physical(view, "g");
      await pause(550);
      assert(!overlay(view), "The disabled hint setting still displayed candidates.");
      physical(view, "<Esc>");
    }
    assert(view.state.doc.toString() === source, "The hint suite changed source text.");
    assert(undoDepth(view.state) === initialDepth, "The hint suite added a text history entry.");
  } finally {
    getCM(view)
      ?.state.dialog?.querySelector("input")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          keyCode: 27,
          bubbles: true,
          cancelable: true,
        }),
      );
    physical(view, "<Esc>");
    if (Vim.getVimGlobalState_().macroModeState.isRecording) physical(view, "q");
    if (options.setHintsEnabled) await options.setHintsEnabled(true);
  }
}
