import { EditorSelection, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

class Candidate extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: Candidate): boolean {
    return this.text === other.text;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement("span");
    span.className = "lindvimera-escape-preview";
    span.textContent = this.text;
    return span;
  }
}

const preview = StateEffect.define<string>();
const previewField = StateField.define<{
  text: string;
  selection: EditorSelection;
  decorations: DecorationSet;
}>({
  create: (state) => ({ text: "", selection: state.selection, decorations: Decoration.none }),
  update(value, transaction) {
    let text = value.text;
    let selection = value.selection.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(preview)) {
        text = effect.value;
        if (text) selection = transaction.state.selection;
      }
    }
    if (!text) return { text, selection, decorations: Decoration.none };
    const decorations = Decoration.set(
      selection.ranges.map((range) => {
        const widget = new Candidate(text);
        // A negative side places the candidate before the existing insertion caret.
        // Moving the real selection would alter Vim's last-insert recording.
        return range.empty
          ? Decoration.widget({ widget, side: -1 }).range(range.from)
          : Decoration.replace({ widget, inclusive: false }).range(range.from, range.to);
      }),
    );
    return { text, selection, decorations };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const theme = EditorView.baseTheme({
  ".lindvimera-escape-preview": { whiteSpace: "pre-wrap" },
});

export const escapePreview = [previewField, theme];

export function escapePreviewMoved(view: EditorView): boolean {
  const value = view.state.field(previewField, false);
  return !!value?.text && !value.selection.eq(view.state.selection);
}

/** Keep pending literals at their mapped origin if an external edit moves the selection. */
export function insertEscapeText(view: EditorView, text: string): void {
  const selection = view.state.field(previewField, false)?.selection ?? view.state.selection;
  const changes = view.state.changes(
    selection.ranges.map((range) => ({ from: range.from, to: range.to, insert: text })),
  );
  view.dispatch({
    changes,
    selection: selection.eq(view.state.selection)
      ? EditorSelection.create(
          selection.ranges.map((range) => EditorSelection.cursor(changes.mapPos(range.to, 1))),
          selection.mainIndex,
        )
      : view.state.selection.map(changes),
    annotations: Transaction.userEvent.of("input.type"),
  });
}

/** Doc-neutral rendering also works in native table cells, which have no Vim instance. */
export function showEscapePreview(view: EditorView, text: string): void {
  const installed = view.state.field(previewField, false);
  if (installed?.text === text || (!installed && !text)) return;
  view.dispatch({
    effects: installed
      ? preview.of(text)
      : [StateEffect.appendConfig.of(escapePreview), preview.of(text)],
  });
}
