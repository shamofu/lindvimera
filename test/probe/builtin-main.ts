import { Plugin, MarkdownView } from "obsidian";
import type { EditorView } from "@codemirror/view";

/** Verifies installed references only; no production or Vim implementation is bundled. */
export default class BuiltinIdentityHarness extends Plugin {
  onload(): void {
    this.addCommand({
      id: "verify-native-identity",
      name: "Verify native Vim identity",
      callback: () => {
        const plugins = (this.app as unknown as { plugins: { plugins: Record<string, unknown> } })
          .plugins.plugins;
        const production = plugins.lindvimera as
          | {
              runtime?: {
                version?: number;
                engine?: { active?: string };
                backend?: { Vim?: unknown; getCM?: (view: EditorView) => unknown };
              };
            }
          | undefined;
        const runtime = production?.runtime;
        if (runtime?.version !== 2 || runtime.engine?.active !== "builtin")
          throw new Error("The installed builtin backend is not active.");
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editorView = (view?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
        const native = (window as unknown as { CodeMirrorAdapter?: { Vim?: unknown } })
          .CodeMirrorAdapter;
        if (!native?.Vim || runtime.backend?.Vim !== native.Vim)
          throw new Error("Builtin Vim is not the host native core.");
        const nativeAdapter = (
          editorView as
            | (EditorView & { cm?: { cm6?: EditorView; state?: { vim?: unknown } } })
            | undefined
        )?.cm;
        if (
          !editorView ||
          !nativeAdapter?.state?.vim ||
          nativeAdapter.cm6 !== editorView ||
          runtime.backend.getCM?.(editorView) !== nativeAdapter
        )
          throw new Error("The active native adapter is unavailable.");
        console.info("Lindvimera builtin identity verified", { engine: "builtin", version: 2 });
      },
    });
  }
}
