import {
  Annotation,
  EditorState,
  Prec,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { Vim, type CodeMirror } from "@replit/codemirror-vim";

/** A host transaction belongs to one logical Vim edit, including its Insert tail. */
export const vimEditGroup = Annotation.define<number>();
const lastEditGroup = StateField.define<number>({
  create: () => 0,
  update: (previous, transaction) =>
    transaction.docChanged ? (transaction.annotation(vimEditGroup) ?? 0) : previous,
});
let nextGroup = 1;

export class VimHistoryGroup {
  private id = 0;
  private cm: CodeMirror | null = null;
  private prior: CodeMirror["operationObserver"];
  private operating = false;
  private operationStartedInInsert = false;
  private observer = {
    start: () => {
      this.operating = true;
      this.operationStartedInInsert = !!this.cm?.state.vim?.insertMode;
      if (!this.id) this.id = nextGroup++;
    },
    end: () => {
      this.operating = false;
      if (!this.cm?.state.vim?.insertMode) this.close();
    },
  };
  private onMode = () => {
    if (!this.cm?.state.vim?.insertMode) this.close();
    else if (!this.id) this.id = nextGroup++;
  };

  /** Cells observe input here, while only the parent owns document history. */
  readonly inputExtension: Extension = EditorView.updateListener.of((update) => {
    if (
      !this.cm?.state.vim?.insertMode ||
      update.view !== this.cm.getEditingView() ||
      update.view.composing ||
      update.docChanged ||
      !update.selectionSet ||
      update.startState.selection.eq(update.state.selection) ||
      (this.operating && !this.operationStartedInInsert) ||
      Vim.getVimGlobalState_().macroModeState.isPlaying ||
      !update.transactions.some((transaction) => transaction.isUserEvent("select"))
    )
      return;
    // Only a real user selection move starts the next edit. Typing, preview
    // effects and host restoration of a regenerated cell keep the existing group.
    this.id = nextGroup++;
  });

  readonly extension: Extension = [
    lastEditGroup,
    this.inputExtension,
    Prec.highest(
      EditorState.transactionFilter.of((transaction) => {
        if (
          transaction.docChanged &&
          (transaction.isUserEvent("set") ||
            (!transaction.annotation(Transaction.userEvent) && !this.operating))
        ) {
          this.close();
          return [{ annotations: isolateHistory.of("full") }, transaction];
        }
        if (
          !transaction.docChanged ||
          transaction.annotation(Transaction.addToHistory) === false ||
          transaction.isUserEvent("undo") ||
          transaction.isUserEvent("redo") ||
          transaction.isUserEvent("set")
        )
          return transaction;
        if (!this.id) return transaction;
        const continuing = transaction.startState.field(lastEditGroup) === this.id;
        // CodeMirror's compose event deliberately joins across time gaps and cursor
        // transactions. A unique first event isolates this Vim edit from its predecessor.
        const annotations = [
          vimEditGroup.of(this.id),
          Transaction.userEvent.of(continuing ? "input.type.compose" : "input.lindvimera.command"),
        ];
        if (!continuing) annotations.push(isolateHistory.of("before"));
        return [{ annotations }, transaction];
      }),
    ),
  ];

  attach(cm: CodeMirror): void {
    this.cm = cm;
    this.prior = cm.operationObserver;
    cm.operationObserver = this.observer;
    cm.on("vim-mode-change", this.onMode);
  }

  /** Focus/settings/external document changes terminate the current input group. */
  close(): void {
    this.id = 0;
  }

  begin(): void {
    if (!this.id) this.id = nextGroup++;
  }

  destroy(): void {
    if (this.cm) {
      this.cm.off("vim-mode-change", this.onMode);
      if (this.cm.operationObserver === this.observer) this.cm.operationObserver = this.prior;
    }
    this.cm = null;
    this.close();
  }
}
