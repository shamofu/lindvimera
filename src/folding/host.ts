import { foldedRanges, unfoldEffect } from "@codemirror/language";
import { Transaction, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { FoldRange } from "./ranges";

export function sourceFold(state: EditorState, from: number, to: number): FoldRange {
  return {
    from,
    to,
    firstLine: state.doc.lineAt(from).number,
    lastLine: state.doc.lineAt(Math.max(from, to - 1)).number,
  };
}

export function currentFolds(state: EditorState): FoldRange[] {
  const result: FoldRange[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    result.push(sourceFold(state, from, to));
  });
  return result;
}

/** Reveal a host widget before waiting for its native editing surface to materialize. */
export function revealFoldedRange(view: EditorView, from: number, to = from): void {
  const effects = currentFolds(view.state)
    .filter((fold) => fold.from < to && fold.to > from)
    .map((fold) => unfoldEffect.of({ from: fold.from, to: fold.to }));
  if (effects.length) view.dispatch({ effects, annotations: Transaction.addToHistory.of(false) });
}
