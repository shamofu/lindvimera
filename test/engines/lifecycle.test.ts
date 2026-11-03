import { describe, expect, it } from "vitest";
import { EngineController } from "../../src/engines/controller";
import { resolveEngineSelection } from "../../src/engines/selection";
import { loadSettings } from "../../src/settings";
import type { BackendHost, EngineBackend } from "../../src/engines/types";

describe("reload-only engine ownership", () => {
  function setup(engine?: "embedded" | "builtin") {
    const settings = loadSettings({ engine });
    let native = false;
    let inputEnabled = false;
    let creates = 0;
    let disposes = 0;
    const writes: boolean[] = [];
    const errors: string[] = [];
    let loaderGate: Promise<void> = Promise.resolve();
    const descriptor = {
      id: engine ?? "embedded",
      nativeVim: engine === "builtin",
      load: async () => {
        await loaderGate;
        return {
          createBackend(host: BackendHost): EngineBackend {
            creates++;
            return {
              runtime: {},
              refresh: () => {
                inputEnabled = host.isActive();
              },
              flush() {},
              applySettings() {},
              dispose: () => {
                disposes++;
                inputEnabled = false;
              },
            };
          },
        };
      },
    };
    const controller = new EngineController(descriptor, {
      settings: () => settings,
      nativeVim: () => native,
      setNativeVim: (value: boolean) => {
        native = value;
        writes.push(value);
      },
      reportError: (message: string) => errors.push(message),
      registerEditorExtension() {},
    } as unknown as ConstructorParameters<typeof EngineController>[1]);
    return {
      controller,
      settings,
      writes,
      errors,
      setNative: (value: boolean) => {
        native = value;
      },
      setGate: (gate: Promise<void>) => {
        loaderGate = gate;
      },
      snapshot: () => ({ native, inputEnabled, creates, disposes }),
    };
  }

  it("keeps the legacy absence on ordinary saves without claiming the native flag", async () => {
    const s = setup();
    s.setNative(true);
    await s.controller.start();
    expect(s.writes).toEqual([]);
    expect(JSON.parse(JSON.stringify(s.settings))).not.toHaveProperty("engine");
    expect(s.controller.status).toBe("suspended");
    expect(s.controller.isActive()).toBe(false);
  });

  it("syncs an explicit choice only at load and freezes the active backend", async () => {
    const s = setup("builtin");
    await s.controller.start();
    expect(s.writes).toEqual([true]);
    expect(s.snapshot()).toMatchObject({ native: true, inputEnabled: true, creates: 1 });
    s.settings.engine = "embedded";
    s.controller.refresh();
    expect(s.controller.id).toBe("builtin");
    expect(s.writes).toEqual([true]);
    expect(s.controller.isActive()).toBe(true);
  });

  it("stops input immediately on conflicting host flag and never fights the host", async () => {
    const s = setup("embedded");
    await s.controller.start();
    s.setNative(true);
    expect(s.controller.isActive()).toBe(false);
    s.controller.refresh();
    expect(s.snapshot().inputEnabled).toBe(false);
    expect(s.controller.status).toBe("suspended");
    expect(s.writes).toEqual([]);
    s.controller.dispose();
    expect(s.snapshot()).toMatchObject({ native: true, disposes: 1 });
  });

  it("cannot register an engine after unload while its loader was pending", async () => {
    const s = setup("builtin");
    let release!: () => void;
    s.setGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const starting = s.controller.start();
    s.controller.dispose();
    release();
    await starting;
    expect(s.snapshot()).toMatchObject({ creates: 0, native: true });
    expect(s.controller.status).toBe("disposed");
  });

  it("reports initialization failure without silently creating the other engine", async () => {
    const s = setup("builtin");
    s.setGate(Promise.reject(new Error("native API unavailable")));
    await s.controller.start();
    expect(s.controller.status).toBe("failed");
    expect(s.controller.isActive()).toBe(false);
    expect(s.snapshot().creates).toBe(0);
    expect(s.errors.join(" ")).toContain("native API unavailable");
  });
});

describe("engine removal migration", () => {
  it.each([
    ["embedded", "builtin"],
    ["builtin", "embedded"],
  ] as const)("preserves preferences when %s is removed", (removed, survivor) => {
    const saved = loadSettings({
      engine: removed,
      japanese: false,
      escapeSequences: ["jj"],
      keyBindings: [{ mode: "normal", from: "Q", to: "dw" }],
    });
    const result = resolveEngineSelection(saved.engine, [survivor], survivor);
    expect(result).toEqual({ id: survivor, migratedFrom: removed });
    saved.engine = result.id;
    expect(resolveEngineSelection(saved.engine, [survivor], survivor)).toEqual({ id: survivor });
    expect(saved).toMatchObject({
      japanese: false,
      escapeSequences: ["jj"],
      keyBindings: [{ mode: "normal", from: "Q", to: "dw" }],
    });
  });

  it("does not turn an unknown corrupt value into explicit host setting consent", () => {
    const loaded = loadSettings({ engine: "future-or-invalid" });
    expect(loaded).not.toHaveProperty("engine");
    expect(resolveEngineSelection(loaded.engine, ["embedded", "builtin"], "embedded")).toEqual({
      id: "embedded",
    });
  });
});
