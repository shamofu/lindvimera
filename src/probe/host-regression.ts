import { MarkdownView, TFile, type App } from "obsidian";
import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import type LindvimeraPlugin from "../main";
import { editorSession } from "../runtime/editor";

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
  for (const value of text)
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    );
}

/** Disposable test documents and settings; never registered in a user's ordinary Vault. */
export async function runHostRegression(plugin: LindvimeraPlugin, check: Check): Promise<void> {
  if (!plugin.settings.probeEnabled) throw new Error("Regression workbench is disabled.");
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
