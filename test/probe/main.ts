import { Plugin, Notice, type App } from "obsidian";
import type LindvimeraPlugin from "../../src/main";
import type { InternalRuntime } from "../../src/runtime/internal";
import type { EditorView } from "@codemirror/view";
import { bindRuntime, editorSession, getCM, Vim } from "./runtime";
import { ProbeView, PROBE_VIEW_TYPE } from "./view";

export default class LindvimeraTestHarness extends Plugin {
  runtime!: InternalRuntime;
  production!: LindvimeraPlugin;
  private diagnosticWrite = Promise.resolve();

  onload(): void {
    const plugins = (this.app as App & { plugins: { plugins: Record<string, unknown> } }).plugins;
    const production = plugins.plugins.lindvimera as LindvimeraPlugin | undefined;
    if (!production)
      throw new Error("Load the production Lindvimera plugin before its test harness.");
    this.runtime = bindRuntime(production.runtime);
    this.production = production;
    const observedKeys: unknown[] = [];
    this.registerDomEvent(
      document,
      "keydown",
      (event) => {
        observedKeys.push({
          key: event.key,
          code: event.code,
          trusted: event.isTrusted,
          composing: event.isComposing,
          target: (event.target as HTMLElement)?.className,
          focus: document.activeElement?.className,
        });
        if (observedKeys.length > 30) observedKeys.shift();
        const snapshot = JSON.stringify(observedKeys, null, 2);
        this.diagnosticWrite = this.diagnosticWrite
          .then(() => this.app.vault.adapter.write("Lindvimera input diagnostics.json", snapshot))
          .catch((error: unknown) => console.error("Lindvimera test input diagnostics:", error));
      },
      true,
    );
    this.registerView(PROBE_VIEW_TYPE, (leaf) => new ProbeView(leaf, production));
    this.register(() => {
      for (const leaf of this.app.workspace.getLeavesOfType(PROBE_VIEW_TYPE)) leaf.detach();
    });
    this.addCommand({
      id: "open-input-probe",
      name: "Open regression workbench",
      callback: () => void this.openProbe(),
    });
    const runNative = () => {
      const probe = this.app.workspace.getLeavesOfType(PROBE_VIEW_TYPE)[0]?.view;
      if (probe instanceof ProbeView) void probe.runNativeRegression();
    };
    this.addCommand({
      id: "run-native-regression",
      name: "Run native table regression",
      callback: runNative,
    });
    this.addRibbonIcon("table", "Lindvimera: run native table regression", runNative);
    this.app.workspace.onLayoutReady(() => {
      void this.openProbe().catch((error: unknown) => new Notice(String(error)));
    });
  }

  /** Fail if a suite has accidentally obtained a second Vim or session registry. */
  verifyRuntimeIdentity(view: EditorView): void {
    if (
      this.runtime !== this.production.runtime ||
      Vim !== this.runtime.Vim ||
      getCM !== this.runtime.getCM ||
      editorSession !== this.runtime.editorSession
    )
      throw new Error("The harness is not bound to the installed production runtime.");
    const session = editorSession(view);
    if (
      !session ||
      session !== this.production.runtime.editorSession(view) ||
      session.cm !== getCM(view)
    )
      throw new Error("The harness cannot inspect the production editor's actual Vim session.");
  }

  verifyRuntimeVersionGuard(): void {
    try {
      bindRuntime({ ...this.runtime, version: 2 });
    } catch (error) {
      if (error instanceof Error && error.message.includes("requires version 1")) return;
      throw error;
    }
    throw new Error("The harness accepted an incompatible production runtime version.");
  }

  async flushDiagnostics(): Promise<void> {
    await this.diagnosticWrite;
  }

  async openProbe(): Promise<void> {
    const leaf =
      this.app.workspace.getLeavesOfType(PROBE_VIEW_TYPE)[0] ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: PROBE_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
