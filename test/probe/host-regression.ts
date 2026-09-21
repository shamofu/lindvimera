import { MarkdownView, TFile, type App } from "obsidian";
import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type LindvimeraPlugin from "../../src/main";
import { getCM, Vim, editorSession } from "./runtime";
import { extendedEditingCases } from "./editing-cases";
import { answerEx, exEditingCases, submitEx } from "./ex-cases";

type Check = (name: string, callback: () => void | Promise<void>) => Promise<void>;
type Owner = { cm: EditorView; sourceMode: boolean };
const settle = () => new Promise<void>((resolve) => window.setTimeout(resolve, 180));
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function owner(view: MarkdownView): Owner {
  return (view as MarkdownView & { editMode: Owner }).editMode;
}
function key(view: EditorView, text: string) {
  for (const value of text.match(/<[^>]+>|./gu) ?? []) {
    const cm = getCM(view)!;
    cm.operation(() => Vim.handleKey(cm, value, "user"));
  }
}
function physical(view: EditorView, text: string) {
  for (const value of text.match(/<[^>]+>|./gu) ?? []) {
    const control = /^<C-(.)>$/.exec(value);
    const key = control?.[1] ?? (value === "<Esc>" ? "Escape" : value);
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key, ctrlKey: !!control, bubbles: true, cancelable: true }),
    );
  }
}
async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline)
    await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
  assert(condition(), message);
}

/** Disposable test documents and settings; never registered in a user's ordinary Vault. */
export async function runHostRegression(plugin: LindvimeraPlugin, check: Check): Promise<void> {
  const saved = {
    ...plugin.settings,
    keyBindings: [...plugin.settings.keyBindings],
    escapeSequences: [...plugin.settings.escapeSequences],
  };
  const vaultConfig = plugin.app.vault as typeof plugin.app.vault & {
    getConfig(key: string): unknown;
    setConfig(key: string, value: unknown): void;
  };
  const builtinBefore = vaultConfig.getConfig("vimMode");
  const path = "Runtime regression.md";
  const baseline = "alpha beta\n\n| Name | Value |\n| --- | --- |\n| 日本語 | value |\n";
  const existing = plugin.app.vault.getAbstractFileByPath(path);
  const file = existing instanceof TFile ? existing : await plugin.app.vault.create(path, baseline);
  if (existing instanceof TFile) await plugin.app.vault.modify(existing, baseline);
  const leaf = plugin.app.workspace.getLeaf("tab");
  let split: typeof leaf | undefined;
  try {
    vaultConfig.setConfig("vimMode", false);
    plugin.settings.enabled = true;
    await plugin.saveSettings();
    await leaf.openFile(file, { state: { mode: "source", source: true } });
    await settle();
    assert(leaf.view instanceof MarkdownView, "No Markdown editor was opened.");
    const markdown = leaf.view;
    const parent = owner(markdown).cm;
    const seedEx = async (text: string) => {
      const view = owner(leaf.view as MarkdownView).cm;
      key(view, "<Esc>");
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
      });
      view.focus();
      await settle();
      return { view, cm: getCM(view)! };
    };
    await check("host-source-live-preview", async () => {
      assert(editorSession(parent), "Source editor did not receive the production runtime.");
      const cm = getCM(parent)!;
      key(parent, "w");
      assert(cm.getCursor().ch === 6, "Source word motion failed.");
      await leaf.setViewState({
        type: "markdown",
        state: { file: path, mode: "source", source: false },
      });
      await settle();
      assert(
        !owner(markdown).sourceMode && editorSession(owner(markdown).cm),
        "Live Preview transition lost Lindvimera.",
      );
      await leaf.setViewState({
        type: "markdown",
        state: { file: path, mode: "source", source: true },
      });
      await settle();
      assert(
        owner(markdown).sourceMode && editorSession(owner(markdown).cm),
        "Source transition lost Lindvimera.",
      );
    });
    await check("host-extended-editing", async () => {
      for (const source of [true, false]) {
        await leaf.setViewState({
          type: "markdown",
          state: { file: path, mode: "source", source },
        });
        await settle();
        const view = owner(markdown).cm;
        for (const example of extendedEditingCases) {
          key(view, "<Esc>");
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: example.text },
            selection: { anchor: 0 },
            annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
          });
          view.focus();
          await settle();
          physical(view, example.keys);
          assert(
            view.state.doc.toString() === example.result,
            `${source ? "Source" : "Live Preview"} ${example.keys} produced ${JSON.stringify(view.state.doc.toString())}`,
          );
          physical(view, "u");
          assert(view.state.doc.toString() === example.text, `${example.keys} did not undo once`);
        }
      }
      await leaf.setViewState({
        type: "markdown",
        state: { file: path, mode: "source", source: true },
      });
      await settle();
      parent.dispatch({
        changes: { from: 0, to: parent.state.doc.length, insert: baseline },
        selection: { anchor: 0 },
        annotations: Transaction.userEvent.of("set"),
      });
    });
    await check("host-ex-editing-and-addresses", async () => {
      for (const source of [true, false]) {
        await leaf.setViewState({
          type: "markdown",
          state: { file: path, mode: "source", source },
        });
        await settle();
        for (const example of exEditingCases) {
          const { view } = await seedEx(example.text);
          if (example.before) physical(view, example.before);
          submitEx(view, example.command);
          await waitFor(
            () => view.state.doc.toString() === example.result,
            `:${example.command} failed in ${source ? "Source" : "Live Preview"}: ${JSON.stringify(view.state.doc.toString())}`,
          );
          if (example.register)
            assert(
              Vim.getRegisterController().getRegister(example.register.name).toString() ===
                example.register.text,
              `:${example.command} wrote the wrong register.`,
            );
          physical(view, "u");
          await waitFor(
            () => view.state.doc.toString() === example.text,
            `:${example.command} did not undo once.`,
          );
        }
        const { view, cm } = await seedEx("one\ntwo\nthree");
        submitEx(view, "1,2yank a");
        assert(
          Vim.getRegisterController().getRegister("a").toString() === "one\ntwo\n",
          "Ex yank did not retain linewise register content.",
        );
        submitEx(view, "$put a");
        await waitFor(
          () => cm.getValue() === "one\ntwo\nthree\none\ntwo",
          "Ex put did not insert the yanked lines after the final line.",
        );
      }
      await leaf.setViewState({
        type: "markdown",
        state: { file: path, mode: "source", source: true },
      });
      await settle();
    });
    await check("host-ex-rejection-and-confirmation", async () => {
      const { view, cm } = await seedEx("one one one");
      for (const command of [
        "global/one/d",
        "normal x",
        "set number",
        "map Q x",
        "write",
        "%s/one/X/z",
        "%s/[/X/g",
        "1delete | 2delete",
        "%s/missing/X/g",
      ]) {
        const before = cm.getCursor();
        submitEx(view, command);
        await waitFor(() => !cm.state.dialog, `Rejected :${command} retained its prompt.`);
        assert(cm.getValue() === "one one one", `Rejected :${command} changed the note.`);
        assert(
          cm.getCursor().line === before.line && cm.getCursor().ch === before.ch,
          `Rejected :${command} changed the cursor.`,
        );
      }
      physical(view, "*");
      submitEx(view, "nohlsearch");
      assert(
        cm.getValue() === "one one one" && !cm.state.dialog,
        ":nohlsearch did not finish without editing.",
      );
      for (const cancel of ["q", "Escape"]) {
        await seedEx("one one one");
        submitEx(view, "%s/one/X/gc");
        await waitFor(
          () => !!cm.state.dialog?.querySelector("input"),
          "Substitution confirmation did not open.",
        );
        answerEx(cm.state.dialog, "y");
        answerEx(cm.state.dialog, cancel);
        await waitFor(
          () => !cm.state.dialog && cm.getValue() === "X one one",
          `Confirmation ${cancel} did not preserve only accepted replacements.`,
        );
        physical(view, "u");
        await waitFor(
          () => cm.getValue() === "one one one",
          "Confirmed substitution did not undo once.",
        );
      }
      await seedEx("one one one");
      submitEx(view, "%s/one/X/gc");
      answerEx(cm.state.dialog, "y");
      answerEx(cm.state.dialog, "n");
      answerEx(cm.state.dialog, "l");
      await waitFor(
        () => cm.getValue() === "X one X" && !cm.state.dialog,
        "Confirmation y/n/l changed the wrong matches.",
      );
      physical(view, "u");
      await waitFor(
        () => cm.getValue() === "one one one",
        "Multiple accepted confirmations split Undo history.",
      );
    });
    await check("host-ex-confirmation-replay-order", async () => {
      const savedBindings = plugin.settings.keyBindings;
      try {
        plugin.settings.keyBindings = [
          ...savedBindings.filter(
            (binding) => !(binding.mode === "normal" && binding.from === "Q"),
          ),
          { mode: "normal", from: "Q", to: ":%s/one/X/gc<CR>gg0rZ" },
        ];
        await plugin.saveSettings();
        for (const replay of ["macro", "mapping", "last-ex"] as const) {
          const { view, cm } = await seedEx("one one");
          if (replay === "macro") {
            Vim.getRegisterController().getRegister("z").setText(":%s/one/X/gc<CR>gg0rZ");
            physical(view, "@z");
          } else if (replay === "mapping") physical(view, "Q");
          else {
            Vim.getRegisterController().getRegister("z").setText("@:gg0rZ");
            physical(view, "@z");
          }
          await waitFor(
            () => !!cm.state.dialog?.querySelector("input"),
            `${replay} did not pause for confirmation.`,
          );
          assert(cm.getValue() === "one one", `${replay} ran its suffix before confirmation.`);
          answerEx(cm.state.dialog, "a");
          await waitFor(
            () => cm.getValue() === "Z X" && !cm.state.dialog,
            `${replay} did not resume after confirmation.`,
          );
          physical(view, "u");
          await waitFor(
            () => cm.getValue() === "one one",
            `${replay} did not undo its confirmed edit and suffix together.`,
          );
        }
      } finally {
        plugin.settings.keyBindings = savedBindings;
        await plugin.saveSettings();
      }
    });
    await check("host-local-marks-and-edit-tracking", async () => {
      const text = "alpha\n  beta marker\nomega";
      const marked = text.indexOf("marker") + 2;
      for (const source of [true, false]) {
        await leaf.setViewState({
          type: "markdown",
          state: { file: path, mode: "source", source },
        });
        await settle();
        const view = owner(markdown).cm;
        const cm = getCM(view)!;
        key(view, "<Esc>");
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: marked },
          annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
        });
        view.focus();
        physical(view, "magg`a");
        await waitFor(
          () => cm.indexFromPos(cm.getCursor()) === marked,
          "Backtick mark did not restore its exact body position.",
        );
        physical(view, "gg'a");
        await waitFor(
          () => cm.indexFromPos(cm.getCursor()) === text.indexOf("beta"),
          "Apostrophe mark did not restore the first nonblank character.",
        );
        const prefix = "inserted\n";
        view.dispatch({
          changes: { from: 0, insert: prefix },
          annotations: Transaction.userEvent.of("input"),
        });
        physical(view, "gg`a");
        await waitFor(
          () => cm.indexFromPos(cm.getCursor()) === prefix.length + marked,
          "Body mark did not track an insertion before it.",
        );
        assert(
          view.state.doc.toString() === prefix + text,
          "Mark navigation changed note content.",
        );
      }
      await leaf.setViewState({
        type: "markdown",
        state: { file: path, mode: "source", source: true },
      });
      await settle();
    });
    await check("host-counted-local-jumps", async () => {
      const text = "start\nneedle one\nmiddle\nneedle two\nlast";
      const view = owner(markdown).cm;
      const cm = getCM(view)!;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.indexOf("needle") },
        annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
      });
      view.focus();
      physical(view, "*");
      const second = text.lastIndexOf("needle");
      await waitFor(
        () => cm.indexFromPos(cm.getCursor()) === second,
        "Search did not create the second jump destination.",
      );
      physical(view, "G");
      const last = text.indexOf("last");
      await waitFor(
        () => cm.indexFromPos(cm.getCursor()) === last,
        "G did not reach the final line.",
      );
      physical(view, "2<C-o>");
      await waitFor(
        () => cm.indexFromPos(cm.getCursor()) === text.indexOf("needle"),
        "Counted Ctrl-o did not return over search and G.",
      );
      physical(view, "<C-i>");
      await waitFor(
        () => cm.indexFromPos(cm.getCursor()) === second,
        "Ctrl-i skipped the search destination.",
      );
      physical(view, "<C-i>");
      await waitFor(
        () => cm.indexFromPos(cm.getCursor()) === last,
        "Ctrl-i did not restore the final destination.",
      );
      physical(view, "gg<C-o>");
      await waitFor(
        () => cm.indexFromPos(cm.getCursor()) === last,
        "gg did not record its departure position.",
      );
      assert(view.state.doc.toString() === text, "Jump traversal changed note content.");
    });
    await check("host-local-navigation-isolation-and-reset", async () => {
      const text = "alpha beta\ngamma delta";
      const view = owner(markdown).cm;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 3 },
        annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
      });
      view.focus();
      physical(view, "ma");
      const otherPane = plugin.app.workspace.getLeaf("split", "vertical");
      const otherPath = "Runtime navigation other.md";
      const otherExisting = plugin.app.vault.getAbstractFileByPath(otherPath);
      const other =
        otherExisting instanceof TFile
          ? otherExisting
          : await plugin.app.vault.create(otherPath, text);
      try {
        await otherPane.openFile(file, { state: { mode: "source", source: true } });
        await waitFor(
          () => otherPane.view instanceof MarkdownView && !!editorSession(owner(otherPane.view).cm),
          "Second pane did not acquire the runtime.",
        );
        assert(otherPane.view instanceof MarkdownView, "Second navigation pane is missing.");
        const second = owner(otherPane.view).cm;
        await waitFor(
          () => second.state.doc.toString() === text,
          "The second pane did not receive the current note.",
        );
        second.dispatch({ selection: { anchor: text.indexOf("delta") } });
        second.focus();
        physical(second, "magg`a");
        await waitFor(
          () => getCM(second)!.indexFromPos(getCM(second)!.getCursor()) === text.indexOf("delta"),
          "Second pane lost its own mark.",
        );
        view.focus();
        physical(view, "gg`a");
        await waitFor(
          () => getCM(view)!.indexFromPos(getCM(view)!.getCursor()) === 3,
          "Second pane overwrote the first pane's mark.",
        );
        await leaf.openFile(other, { state: { mode: "source", source: true } });
        await waitFor(
          () =>
            leaf.view instanceof MarkdownView &&
            leaf.view.file?.path === otherPath &&
            !!editorSession(owner(leaf.view).cm),
          "Note switch did not complete.",
        );
        const changedView = owner(leaf.view as MarkdownView).cm;
        changedView.dispatch({ selection: { anchor: 0 } });
        changedView.focus();
        physical(changedView, "`a<C-o>");
        await settle();
        assert(
          getCM(changedView)!.indexFromPos(getCM(changedView)!.getCursor()) === 0,
          "A mark or jump survived switching to another note.",
        );
        await leaf.openFile(file, { state: { mode: "source", source: true } });
        await waitFor(
          () =>
            leaf.view instanceof MarkdownView &&
            leaf.view.file?.path === path &&
            !!editorSession(owner(leaf.view).cm),
          "Original note did not reopen.",
        );
        const reopened = owner(leaf.view as MarkdownView).cm;
        reopened.dispatch({ selection: { anchor: 0 } });
        reopened.focus();
        physical(reopened, "`a");
        await settle();
        assert(
          getCM(reopened)!.indexFromPos(getCM(reopened)!.getCursor()) === 0,
          "Reopening a note resurrected discarded marks.",
        );
      } finally {
        otherPane.detach();
        if (leaf.view instanceof MarkdownView && leaf.view.file?.path !== path)
          await leaf.openFile(file, { state: { mode: "source", source: true } });
      }
      const current = owner(leaf.view as MarkdownView).cm;
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: baseline },
        selection: { anchor: 0 },
        annotations: Transaction.addToHistory.of(false),
      });
      current.focus();
    });
    await check("host-split-panes", async () => {
      parent.focus();
      key(parent, "i");
      physical(parent, "j");
      split = plugin.app.workspace.getLeaf("split", "vertical");
      await split.openFile(file, { state: { mode: "source", source: true } });
      await settle();
      assert(split.view instanceof MarkdownView, "Second Markdown pane is missing.");
      const second = owner(split.view).cm;
      second.focus();
      await settle();
      assert(getCM(second) !== getCM(parent), "Split panes share Vim state.");
      assert(!getCM(second)!.state.vim!.insertMode, "Insert mode leaked into another pane.");
      assert(parent.state.doc.toString().includes("j"), "Held input was lost on focus change.");
      key(parent, "<Esc>");
    });
    await check("host-keymap-settings", async () => {
      plugin.settings.keyBindings = [{ mode: "normal", from: "Q", to: "i" }];
      await plugin.saveSettings();
      await settle();
      parent.focus();
      physical(parent, "Q");
      assert(getCM(parent)!.state.vim!.insertMode, "Configured normal-mode mapping did not run.");
      physical(parent, "jj");
      assert(!getCM(parent)!.state.vim!.insertMode, "Configured input could not escape.");
      plugin.settings.keyBindings = [];
      await plugin.saveSettings();
      await settle();
    });
    await check("host-disable-enable", async () => {
      const before = parent.state.doc.toString();
      key(parent, "i");
      physical(parent, "j");
      plugin.settings.enabled = false;
      await plugin.saveSettings();
      await settle();
      assert(!editorSession(parent), "Disabled plugin left a runtime attached.");
      assert(parent.state.doc.length === before.length + 1, "Disable lost a held literal key.");
      plugin.settings.enabled = true;
      await plugin.saveSettings();
      await settle();
      assert(
        editorSession(parent) && !getCM(parent)!.state.vim!.insertMode,
        "Re-enable retained stale Insert state.",
      );
    });
    await check("host-built-in-guard", async () => {
      vaultConfig.setConfig("vimMode", true);
      await settle();
      assert(!editorSession(parent), "Own Vim remained enabled beside the built-in engine.");
      assert(
        (plugin.app as App & { isVimEnabled(): boolean }).isVimEnabled(),
        "Built-in Vim was not actually enabled.",
      );
      vaultConfig.setConfig("vimMode", false);
      await settle();
      assert(
        editorSession(parent) && getCM(parent)?.state.vim,
        "Disabling built-in Vim did not restore the plugin.",
      );
    });
    await check("host-external-edit", async () => {
      key(parent, "<Esc>");
      parent.dispatch({
        changes: { from: 0, to: parent.state.doc.length, insert: baseline },
        annotations: Transaction.userEvent.of("set"),
      });
      await settle();
      await plugin.app.vault.modify(file, "external edit\n");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 800));
      assert(
        parent.state.doc.toString() === "external edit\n",
        "External file update was not reflected.",
      );
      assert(editorSession(parent), "External update detached Lindvimera.");
      key(parent, "gg0w");
      assert(
        getCM(parent)!.getCursor().ch === 9,
        "Motion used stale positions after an external edit.",
      );
    });
  } finally {
    split?.detach();
    leaf.detach();
    vaultConfig.setConfig("vimMode", builtinBefore);
    plugin.settings = saved;
    await plugin.saveSettings();
    await plugin.app.vault.modify(file, baseline);
  }
}
