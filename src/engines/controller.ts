import type { Extension } from "@codemirror/state";
import type { EngineId } from "./selection";
import type { BackendHost, EngineBackend, EngineModule } from "./types";

export type EngineStatus = "loading" | "active" | "suspended" | "failed" | "disposed";

interface ControllerHost extends Omit<BackendHost, "isActive"> {
  nativeVim(): boolean;
  setNativeVim(enabled: boolean): void;
}

interface LoadableEngine {
  id: EngineId;
  nativeVim: boolean;
  load(): Promise<EngineModule>;
}

/** A load owns one backend for its entire lifetime. Settings are only a request. */
export class EngineController {
  readonly id: EngineId;
  status: EngineStatus = "loading";
  private backend?: EngineBackend;
  private starting?: Promise<void>;

  constructor(
    private readonly descriptor: LoadableEngine,
    private readonly host: ControllerHost,
  ) {
    this.id = descriptor.id;
  }

  get runtime(): object | undefined {
    return this.backend?.runtime;
  }

  isActive(): boolean {
    return (
      this.status !== "failed" &&
      this.status !== "disposed" &&
      this.host.settings().enabled &&
      this.host.nativeVim() === this.descriptor.nativeVim
    );
  }

  start(): Promise<void> {
    return (this.starting ??= this.initialize());
  }

  private async initialize(): Promise<void> {
    if (this.status === "disposed") return;
    try {
      if (
        this.host.settings().engine !== undefined &&
        this.host.nativeVim() !== this.descriptor.nativeVim
      )
        this.host.setNativeVim(this.descriptor.nativeVim);
      // setConfig synchronously notifies the host; let its adapter reconfiguration finish.
      await Promise.resolve();
      if (this.isDisposed()) return;
      const module = await this.descriptor.load();
      if (this.isDisposed()) return;
      const extensions: Extension[] = [];
      this.backend = module.createBackend({
        app: this.host.app,
        settings: () => this.host.settings(),
        wordSegmenter: () => this.host.wordSegmenter(),
        reportMode: (mode) => this.host.reportMode(mode),
        reportError: (message) => this.host.reportError(message),
        isActive: () => this.isActive(),
        registerEditorExtension: (extension) => extensions.push(extension),
      });
      this.refresh();
      this.host.registerEditorExtension(extensions);
    } catch (error) {
      this.backend?.dispose();
      this.backend = undefined;
      if (this.isDisposed()) return;
      this.status = "failed";
      this.host.reportError(error instanceof Error ? error.message : String(error));
    }
  }

  refresh(): void {
    if (this.status === "failed" || this.status === "disposed") return;
    this.status = this.isActive() ? "active" : "suspended";
    this.backend?.refresh();
  }

  private isDisposed(): boolean {
    return this.status === "disposed";
  }

  applySettings(appearanceOnly = false): void {
    if (this.status === "failed" || this.status === "disposed") return;
    this.backend?.applySettings(appearanceOnly);
    this.refresh();
  }

  dispose(): void {
    if (this.status === "disposed") return;
    this.status = "disposed";
    this.backend?.dispose();
    this.backend = undefined;
  }
}
