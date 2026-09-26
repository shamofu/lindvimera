import { foldable, foldedRanges, foldEffect } from "@codemirror/language";
import { Transaction } from "@codemirror/state";
import { undoDepth } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { editorSession, getCM, Vim } from "./runtime";

const source =
  "# Parent\nbody\n## Child\nchild text\n## Sibling\nsibling text\n# Other\nother text";
const settleHost = () => new Promise<void>((resolve) => window.setTimeout(resolve, 180));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function key(view: EditorView, sequence: string): void {
  const cm = getCM(view)!;
  for (const token of sequence.match(/<[^>]+>|./gu) ?? [])
    cm.operation(() => Vim.handleKey(cm, token, "user"));
}
async function settled(view: EditorView): Promise<void> {
  const deadline = Date.now() + 3500;
  while (editorSession(view)?.pending.pending && Date.now() < deadline)
    await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
  assert(!editorSession(view)?.pending.pending, "Folding command did not finish.");
}
function closedLines(view: EditorView): number[] {
  const lines: number[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from) => {
    lines.push(view.state.doc.lineAt(from).number);
  });
  return lines.sort((a, b) => a - b);
}
async function seed(view: EditorView, text = source): Promise<void> {
  key(view, "<Esc>");
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: 0 },
    annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
  });
  view.focus();
  await settleHost();
}

/** Run against both Source and Live Preview in the disposable real-host document. */
export async function runFoldingCases(view: EditorView): Promise<void> {
  await seed(view);
  const depth = undoDepth(view.state);
  key(view, "3G2zc");
  await settled(view);
  assert(closedLines(view).join(",") === "1,3", "Counted close did not retain nested host folds.");
  assert(getCM(view)!.getCursor().line === 0, "Closing a parent left its cursor hidden.");
  key(view, "zO");
  await settled(view);
  assert(!closedLines(view).length, "Recursive open left a nested fold closed.");
  key(view, "zM");
  await settled(view);
  assert(closedLines(view).join(",") === "1,3,5,7", "Global close missed hidden descendants.");
  key(view, "zo");
  await settled(view);
  assert(closedLines(view).join(",") === "3,5,7", "One-level open also opened child folds.");
  key(view, "zR");
  await settled(view);
  assert(!closedLines(view).length, "Global open left folds closed.");

  for (const visual of ["v", "V", "<C-v>"]) {
    key(view, `5G${visual}3GzC`);
    await settled(view);
    assert(!getCM(view)!.state.vim!.visualMode, "Visual fold command did not end Visual mode.");
    assert(
      closedLines(view).join(",") === "1,3,5",
      "Reverse Visual range folded the wrong headings.",
    );
    key(view, "gv");
    const vim = getCM(view)!.state.vim!;
    assert(
      vim.visualMode && vim.sel.anchor.line === 4 && vim.sel.head.line === 2,
      "Folding did not preserve the original Visual selection for gv.",
    );
    key(view, "<Esc>zR");
    await settled(view);
  }
  assert(view.state.doc.toString() === source, "Folding changed the note source.");
  assert(undoDepth(view.state) === depth, "Folding added a text history entry.");

  // A fold created by Obsidian's standard effect must be visible to Vim open commands.
  const hostFold = foldable(view.state, 0, view.state.doc.line(1).to);
  assert(hostFold, "The host did not provide a heading fold.");
  view.dispatch({ effects: foldEffect.of(hostFold) });
  key(view, "ggzo");
  await settled(view);
  assert(!closedLines(view).length, "Vim could not open a fold created by the host.");

  // Whole-document operations must reach beyond the initially parsed/rendered viewport.
  await seed(view, `${source}\n${"plain text\n".repeat(600)}# Far away\nfar body\n`);
  key(view, "zM");
  await settled(view);
  assert(closedLines(view).includes(609), "Global close omitted the offscreen heading.");
  key(view, "zR");
  await settled(view);
  assert(!closedLines(view).length, "Global open omitted an offscreen fold.");
}
