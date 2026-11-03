import type { NativeCM, NativeVim } from "./native";

type ModeFunction = (cm: NativeCM, keepCursor?: boolean) => void;
interface GuardState {
  enabled: boolean;
  adapters: WeakSet<NativeCM>;
}

function guarded(previous: ModeFunction, state: GuardState): ModeFunction {
  return function (this: NativeVim, cm, keepCursor) {
    // Obsidian 1.15 mirrors parent/cell modes in a timer captured when the cell
    // is created. A cell can be destroyed before that timer runs.
    if (state.enabled && state.adapters.has(cm) && !cm.state.vim) return;
    previous.call(this, cm, keepCursor);
  };
}

/** Guard only delayed native mode calls for adapters we actually attached to. */
export class NativeAdapterLifetime {
  private state: GuardState = { enabled: true, adapters: new WeakSet() };
  private installed = new Map<
    NativeVim,
    { key: "enterInsertMode" | "exitInsertMode"; previous: ModeFunction; owned: ModeFunction }[]
  >();

  track(cm: NativeCM, vim: NativeVim): void {
    this.state.adapters.add(cm);
    if (this.installed.has(vim)) return;
    const hooks = [];
    for (const key of ["enterInsertMode", "exitInsertMode"] as const) {
      const previous = vim[key];
      if (typeof previous !== "function") continue;
      const owned = guarded(previous, this.state);
      vim[key] = owned;
      hooks.push({ key, previous, owned });
    }
    this.installed.set(vim, hooks);
  }

  dispose(): void {
    this.state.enabled = false;
    this.state.adapters = new WeakSet();
    for (const [vim, hooks] of this.installed)
      for (const hook of hooks) if (vim[hook.key] === hook.owned) vim[hook.key] = hook.previous;
    this.installed.clear();
  }
}
