import type { NativeCommandQueue, NativeContinuation } from "./ex-mapping";
import { withMappings, type NativeCM, type NativeCommand, type NativeVim } from "./native";

interface NativeRegister {
  keyBuffer: string[];
  insertModeChanges: unknown[];
  searchQueries: unknown[];
}
interface RegisterController {
  getRegister: (name: string) => NativeRegister;
}
interface MacroState {
  latestRegister?: string;
  replaySearchQueries: unknown[];
}
interface MacroAPI extends NativeVim {
  getRegisterController(): RegisterController;
  getVimGlobalState_(): { macroModeState: MacroState };
}
interface Replay {
  name: string;
  remaining: number;
  keys?: string[];
  inserts?: unknown[];
  searches?: unknown[];
  canceled: boolean;
}

const owners = new WeakMap<NativeCM, NativeMacroCoordinator>();
const defined = new WeakSet<NativeVim>();
const action = "lindvimera115_nativeMacro";
const sentinel = "<lindvimeraNativeMacro>";
const postInsert = "<lindvimeraNativePostInsert>";
const noop = "lindvimera115_nativeMacroPostInsert";

/** Match the installed executor's tokenization, including UTF-16 literal keys. */
function nativeKeys(buffer: string[]): string[] {
  return buffer.flatMap((text) => text.match(/<\w+-.+?>|<\w+>|./g) ?? []);
}

/** Suspend native macro iterations at asynchronous addon boundaries. Insert,
 * search, replace and visual-block records are always replayed by native Vim. */
export class NativeMacroCoordinator {
  private adapters = new Set<NativeCM>();
  private replays = new Set<Replay>();
  private disposed = false;
  private invocation = 0;

  constructor(
    private vim: NativeVim,
    private queue: NativeCommandQueue,
  ) {
    if (!defined.has(vim)) {
      vim.defineAction(action, (cm, args) =>
        owners.get(cm)?.play(cm, args.selectedCharacter ?? "", args.repeat),
      );
      vim.defineAction(noop, () => {});
      defined.add(vim);
    }
  }

  attach(cm: NativeCM): void {
    this.adapters.add(cm);
    owners.set(cm, this);
  }

  detach(cm: NativeCM): boolean {
    if (owners.get(cm) === this) owners.delete(cm);
    this.adapters.delete(cm);
    return this.adapters.size === 0;
  }

  commands(): NativeCommand[] {
    return [{ keys: "@<register>", type: "action", action }];
  }

  private play(cm: NativeCM, requested: string, count: number): void {
    if (this.disposed) return;
    const api = this.vim as MacroAPI;
    const state = api.getVimGlobalState_().macroModeState;
    const name = requested === "@" ? (state.latestRegister ?? "") : requested;
    state.latestRegister = name;
    this.invocation++;
    if (name === ":" || !name) {
      this.native(cm, name, count);
      return;
    }
    const replay: Replay = { name, remaining: Math.max(1, count), canceled: false };
    this.replays.add(replay);
    this.resume(cm, replay);
  }

  private native(cm: NativeCM, name: string, count = 1): void {
    const command: NativeCommand = {
      keys: sentinel,
      type: "action",
      action: "replayMacro",
      actionArgs: { selectedCharacter: name },
      context: cm.state.vim?.insertMode ? "insert" : cm.state.vim?.visualMode ? "visual" : "normal",
    };
    withMappings(
      this.vim,
      [command, { keys: postInsert, type: "action", action: noop, context: "insert" }],
      () => {
        for (let iteration = 0; iteration < count; iteration++)
          this.vim.handleKey(cm, sentinel, "mapping");
      },
    );
  }

  private resume(cm: NativeCM, replay: Replay): void {
    if (this.disposed || replay.canceled) return;
    const api = this.vim as MacroAPI;
    const controller = api.getRegisterController();
    while (replay.remaining && !replay.canceled) {
      if (replay.keys && !replay.keys.length && !cm.state.vim?.insertMode) {
        replay.remaining--;
        replay.keys = replay.inserts = replay.searches = undefined;
        continue;
      }
      const source = controller.getRegister(replay.name);
      const keys = replay.keys
        ? [
            ...(cm.state.vim?.insertMode && replay.inserts?.length ? [postInsert] : []),
            ...replay.keys,
          ]
        : nativeKeys(source.keyBuffer);
      const inserts = replay.inserts ?? source.insertModeChanges;
      const searches = replay.searches ?? source.searchQueries;
      let index = -1;
      let consumed = 0;
      let remainingSearches = searches.slice();
      let paused = false;
      // Clone only the register shell. Native insertion/search objects retain
      // their prototypes and identity, including InsertModeKey instances.
      const scratch = Object.assign(
        Object.create(Object.getPrototypeOf(source) as object | null) as NativeRegister,
        source,
      );
      scratch.keyBuffer = new Proxy(keys.slice(), {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/u.test(property)) index = Number(property);
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      scratch.insertModeChanges = new Proxy(inserts.slice(), {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/u.test(property))
            consumed = Math.max(consumed, Number(property) + 1);
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      scratch.searchQueries = searches.slice();
      scratch.searchQueries.slice = () => (remainingSearches = searches.slice());
      const previous = controller.getRegister;
      const owned: RegisterController["getRegister"] = function (this: RegisterController, name) {
        // The native executor captures its register once. Restore immediately
        // so writes performed by the macro still reach the real user register.
        if (controller.getRegister === owned) controller.getRegister = previous;
        return name.toLowerCase() === replay.name.toLowerCase()
          ? scratch
          : previous.call(this, name);
      };
      const state = api.getVimGlobalState_().macroModeState;
      const latest = state.latestRegister;
      const invocation = this.invocation;
      controller.getRegister = owned;
      try {
        this.queue.withNativeFrame(
          () => this.native(cm, replay.name),
          (): NativeContinuation => {
            paused = true;
            replay.keys = keys.slice(index + 1);
            scratch.keyBuffer.length = index + 1;
            return {
              run: (target) => this.resume(target, replay),
              cancel: () => this.cancel(replay),
            };
          },
        );
      } finally {
        if (controller.getRegister === owned) controller.getRegister = previous;
        if (this.invocation === invocation && state.latestRegister === replay.name)
          state.latestRegister = latest;
      }
      if (paused) {
        replay.inserts = inserts.slice(consumed);
        replay.searches = remainingSearches.slice();
        // An empty key tail can still have the native post-key Insert phase.
        // A queued mapping may enter Insert after the original executor returned.
        return;
      }
      replay.remaining--;
      replay.keys = replay.inserts = replay.searches = undefined;
    }
    this.replays.delete(replay);
  }

  private cancel(replay: Replay): void {
    replay.canceled = true;
    replay.keys = replay.inserts = replay.searches = undefined;
    this.replays.delete(replay);
  }

  dispose(): void {
    this.disposed = true;
    for (const replay of this.replays) this.cancel(replay);
    for (const cm of this.adapters) if (owners.get(cm) === this) owners.delete(cm);
    this.adapters.clear();
  }
}
