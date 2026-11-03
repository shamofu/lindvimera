import { describe, expect, it } from "vitest";
import { NativeMacroCoordinator } from "../src/engines/builtin/macros";
import { NativeCommandQueue } from "../src/engines/builtin/ex-mapping";
import type {
  NativeAction,
  NativeCM,
  NativeCommand,
  NativeVim,
} from "../src/engines/builtin/native";

function fixture() {
  const cm = { state: { vim: { insertMode: false } } } as unknown as NativeCM;
  const other = { state: { vim: { insertMode: false } } } as unknown as NativeCM;
  const insert = { changes: [new (class NativeInsertRecord {})()] };
  const register = { keyBuffer: ["Qi/j"], insertModeChanges: [insert], searchQueries: [/needle/u] };
  const state = { latestRegister: "", isPlaying: false, replaySearchQueries: [] as unknown[] };
  const controller = { getRegister: (_name: string) => register };
  const originalGetter = controller.getRegister;
  const actions = new Map<string, NativeAction>();
  const maps: NativeCommand[] = [];
  const events: unknown[] = [];
  let target = cm;
  let active = true;
  let pause: Promise<void> | undefined;
  let mutateRegister = false;
  let rhs = "z";
  const vim = {
    defineAction: (name: string, callback: NativeAction) => actions.set(name, callback),
    getRegisterController: () => controller,
    getVimGlobalState_: () => ({ macroModeState: state }),
    _mapCommand: (command: NativeCommand) => maps.push(command),
    unmap: (key: string, context?: string) => {
      const index = maps.findIndex(
        (command) => command.keys === key && command.context === context,
      );
      maps.splice(index, 1);
    },
    handleKey: (editor: NativeCM, key: string, origin?: string) => {
      const queued = queue.intercept(editor, key, origin);
      if (queued) return queued();
      const command = maps.find((command) => command.keys === key);
      if (command?.action === "replayMacro") {
        const name = command.actionArgs!.selectedCharacter!;
        state.latestRegister = name;
        const replay = controller.getRegister(name);
        const buffer = replay.keyBuffer;
        let inserted = 0;
        state.isPlaying = true;
        state.replaySearchQueries = replay.searchQueries.slice();
        // The installed native executor's important ownership and ordering:
        // capture register and buffer once, read insertion records after keys.
        for (let index = 0; index < buffer.length; index++) {
          for (const token of buffer[index].match(/<\w+-.+?>|<\w+>|./g) ?? []) {
            vim.handleKey(editor, token, "macro");
            if (editor.state.vim!.insertMode) {
              events.push(replay.insertModeChanges[inserted++]);
              editor.state.vim!.insertMode = false;
            }
          }
        }
        state.isPlaying = false;
      } else {
        events.push([editor === cm ? "first" : "restored", key]);
        if (key === "Q") {
          if (mutateRegister) controller.getRegister("a").keyBuffer = ["j"];
          if (pause) queue.waitFor(pause, () => {});
          else queue.run(rhs);
        } else if (key === "i") editor.state.vim!.insertMode = true;
        else if (key === "/") events.push(state.replaySearchQueries.shift());
      }
      return true;
    },
  } as unknown as NativeVim;
  const queue = new NativeCommandQueue({
    liveTargetCM: () => target,
    isActive: () => active,
    dispatch: (editor, key, origin) => vim.handleKey(editor, key, origin),
  });
  const macro = new NativeMacroCoordinator(vim, queue);
  macro.attach(cm);
  const play = (repeat = 1) =>
    actions.get(macro.commands()[0].action!)!(
      cm,
      { repeat, selectedCharacter: "a" },
      cm.state.vim!,
    );
  return {
    cm,
    other,
    register,
    insert,
    controller,
    originalGetter,
    events,
    queue,
    macro,
    play,
    setTarget: (editor: NativeCM) => {
      target = editor;
      macro.attach(editor);
    },
    pause: (task: Promise<void>) => {
      pause = task;
    },
    deactivate: () => {
      active = false;
    },
    mutate: () => {
      mutateRegister = true;
    },
    mapping: (keys: string) => {
      rhs = keys;
    },
  };
}

describe("segmented native macro replay", () => {
  it("replays native insertion and search records after mapped RHS, preserving register identity", async () => {
    const f = fixture();
    const keys = f.register.keyBuffer;
    const inserts = f.register.insertModeChanges;
    f.play();
    expect(f.controller.getRegister).toBe(f.originalGetter);
    await f.queue.settled();
    expect(f.events).toEqual([
      ["first", "Q"],
      ["first", "z"],
      ["first", "i"],
      f.insert,
      ["first", "/"],
      /needle/u,
      ["first", "j"],
    ]);
    expect(f.register.keyBuffer).toBe(keys);
    expect(f.register.insertModeChanges).toBe(inserts);
    expect(f.cm.state.vim?.insertMode).toBe(false);
  });

  it("resumes on the restored editor and repeats native iterations without flattening records", async () => {
    const f = fixture();
    let release!: () => void;
    f.pause(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    f.play(2);
    f.setTarget(f.other);
    release();
    await f.queue.settled();
    expect(f.events.filter((event) => event === f.insert)).toHaveLength(2);
    expect(f.events).toContainEqual(["restored", "i"]);
    expect(f.events).toContainEqual(["restored", "Q"]);
  });

  it("does not roll back writes to the real macro register and rereads it for the next count", async () => {
    const f = fixture();
    f.mutate();
    f.play(2);
    await f.queue.settled();
    expect(f.register.keyBuffer).toEqual(["j"]);
    expect(f.events.filter((event) => Array.isArray(event) && event[1] === "Q")).toHaveLength(1);
    expect(f.events.filter((event) => event === f.insert)).toHaveLength(1);
  });

  it("discards native continuation records on cancellation", async () => {
    const f = fixture();
    f.pause(new Promise(() => {}));
    f.play();
    f.queue.cancel();
    await f.queue.settled();
    expect(f.events).toEqual([["first", "Q"]]);
    expect(f.controller.getRegister).toBe(f.originalGetter);
    f.macro.dispose();
  });

  it("lets native replay finish a delayed Insert phase even when the macro has no key tail", async () => {
    const f = fixture();
    f.register.keyBuffer = ["Q"];
    f.mapping("i");
    f.play();
    await f.queue.settled();
    expect(f.events.filter((event) => event === f.insert)).toHaveLength(1);
    expect(f.cm.state.vim?.insertMode).toBe(false);
  });
});
