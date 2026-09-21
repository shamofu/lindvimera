import { MapMode, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { Vim, type CodeMirror } from "@replit/codemirror-vim";
import type { Pos } from "@replit/codemirror-vim-core";
import { parseMarkdownTable } from "../table/source";
import {
  focusNativeBody,
  nativeCellCoordinates,
  resolveNativeTable,
  restoreNativeCell,
} from "../table/native-adapter";
import {
  cellTarget,
  copyPosition,
  mapParentPosition,
  samePosition,
  sameTarget,
  type NativeCellChange,
  type NavigationPosition,
} from "./positions";

export interface NavigationOptions {
  owner(): unknown;
  documentIdentity(): unknown;
  waitFor(task: Promise<void>, cancel: () => void): void;
  cancelPending(): void;
  afterRestore(): void;
  error?(message: string): void;
}

const sessions = new WeakMap<object, NavigationSession>();
let installed = false;

export function installNavigationCommands(): void {
  if (installed) return;
  installed = true;
  Vim.defineAction("lindvimeraSetMark", (cm, args) =>
    sessions.get(cm)?.setMark(args.selectedCharacter ?? ""),
  );
  Vim.defineAction("lindvimeraGoToMark", (cm, args) =>
    sessions.get(cm)?.goToMark(args.selectedCharacter ?? "", !!args.linewise),
  );
  Vim.defineAction("lindvimeraJumpBack", (cm, args) =>
    sessions.get(cm)?.walk(-1, args.repeat ?? 1),
  );
  Vim.defineAction("lindvimeraJumpForward", (cm, args) =>
    sessions.get(cm)?.walk(1, args.repeat ?? 1),
  );
  for (const [keys, action, args] of [
    ["m<register>", "lindvimeraSetMark", {}],
    ["'<register>", "lindvimeraGoToMark", { linewise: true }],
    ["`<register>", "lindvimeraGoToMark", { linewise: false }],
    ["<C-o>", "lindvimeraJumpBack", {}],
    ["<C-i>", "lindvimeraJumpForward", {}],
  ] as const) {
    Vim.mapCommand(keys, "action", action, args, {
      context: "normal",
      when: (cm: object) => sessions.has(cm),
    });
  }
}

/** Source coordinates belong to one editor session and never to the global Vim state. */
export class NavigationSession {
  private identity: unknown;
  private generation = 0;
  private destroyed = false;
  private readonly marks = new Map<string, NavigationPosition>();
  private jumps: NavigationPosition[] = [];
  private pointer = -1;
  private readonly transient = new Set<NavigationPosition>();
  private nativeChanges: NativeCellChange[] = [];
  private readonly seen = new WeakSet<ViewUpdate>();
  private readonly previousProvider: CodeMirror["state"]["navigationProvider"];
  private readonly provider = {
    recordJump: (from: Pos, to: Pos) => {
      this.ensureIdentity();
      this.record(this.capture(from), this.capture(to));
    },
    resolveMark: (name: string): Pos | null => {
      this.ensureIdentity();
      const mark = this.marks.get(name);
      if (!mark?.valid) return null;
      const current = this.capture();
      return sameTarget(mark.target, current.target) ? this.cm.posFromIndex(mark.offset) : null;
    },
  };

  readonly inputExtension: Extension;

  constructor(
    readonly cm: CodeMirror,
    private readonly options: NavigationOptions,
  ) {
    this.identity = options.documentIdentity();
    this.previousProvider = cm.state.navigationProvider;
    cm.state.navigationProvider = this.provider;
    sessions.set(cm, this);
    installNavigationCommands();
    const updateNavigation = (update: ViewUpdate) => this.update(update);
    // Plugins run before native update listeners serialize the complete cell into its parent.
    this.inputExtension = ViewPlugin.fromClass(
      class {
        update(update: ViewUpdate) {
          updateNavigation(update);
        }
      },
    );
  }

  private ensureIdentity(): void {
    const identity = this.options.documentIdentity();
    if (identity !== this.identity) {
      this.reset();
      this.identity = identity;
    }
  }

  private positions(): Set<NavigationPosition> {
    return new Set([...this.marks.values(), ...this.jumps, ...this.transient]);
  }

  update(update: ViewUpdate): void {
    if (this.destroyed || this.seen.has(update)) return;
    this.seen.add(update);
    this.ensureIdentity();
    if (!update.docChanged) return;
    if (update.view === this.cm.cm6) {
      for (const position of this.positions())
        mapParentPosition(position, update.changes, update.state.doc, this.nativeChanges);
      this.nativeChanges = [];
      return;
    }
    if (update.view !== this.cm.getEditingView()) return;
    const coordinates = nativeCellCoordinates(this.options.owner(), this.cm.cm6);
    if (!coordinates) return;
    let target: NativeCellChange["target"] | undefined;
    try {
      const model = parseMarkdownTable(
        this.cm.cm6.state.doc.sliceString(coordinates.tableFrom, coordinates.tableTo),
        coordinates.tableFrom,
      );
      const cell = model.rows[coordinates.row]?.[coordinates.column];
      if (cell) {
        // A parent Undo/source edit may subsequently mirror into the native surface.
        if (
          cell.map.text === update.state.doc.toString().trim() &&
          cell.map.text !== update.startState.doc.toString().trim()
        )
          return;
        target = cellTarget(model, cell);
      }
    } catch {
      /* A disappearing table has no restorable coordinates. */
    }
    for (const position of this.positions()) {
      if (
        !position.valid ||
        position.target.kind !== "cell" ||
        position.target.tableFrom !== coordinates.tableFrom ||
        position.target.from !== coordinates.from ||
        position.target.to !== coordinates.to
      )
        continue;
      target ??= { ...position.target };
      // Parent-driven mirror updates are already reflected by mapParentPosition.
      if (position.target.text === update.state.doc.toString()) continue;
      const offset = update.changes.mapPos(position.offset, 1, MapMode.TrackDel);
      if (offset === null) position.valid = false;
      else position.offset = offset;
    }
    if (target) this.nativeChanges.push({ target, text: update.state.doc.toString() });
  }

  private capture(pos = this.cm.getCursor()): NavigationPosition {
    const offset = this.cm.indexFromPos(pos);
    if (this.cm.getEditingView() === this.cm.cm6)
      return { target: { kind: "body" }, offset, valid: true };
    const resolution = resolveNativeTable(this.options.owner(), this.cm.cm6);
    if (!resolution.supported) throw new Error(resolution.reason);
    const table = resolution.context.snapshot();
    const current = resolution.context.currentCell;
    if (!current) throw new Error("現在のセル位置を確認できません。");
    return {
      target: cellTarget(table, table.rows[current.row][current.column]),
      offset,
      valid: true,
    };
  }

  setMark(name: string): void {
    this.ensureIdentity();
    if (!/^[a-z]$/.test(name)) return;
    try {
      this.marks.set(name, this.capture());
    } catch (error) {
      this.start(async () => {
        throw error;
      });
    }
  }

  goToMark(name: string, linewise = false): void {
    this.ensureIdentity();
    this.start(async (check) => {
      const mark = this.marks.get(name);
      if (!mark?.valid) throw new Error(`マーク ${name} の移動先は存在しません。`);
      const origin = this.capture();
      this.transient.add(origin);
      try {
        await this.restore(mark, linewise, check);
        check();
        this.record(origin, this.capture());
      } catch (error) {
        if (check(false)) await this.restore(origin, false, check).catch(() => {});
        throw error;
      } finally {
        this.transient.delete(origin);
      }
    });
  }

  walk(direction: -1 | 1, count: number): void {
    this.ensureIdentity();
    this.start(async (check) => {
      const origin = this.capture();
      const originalJumps = this.jumps.slice();
      const originalPointer = this.pointer;
      if (direction < 0 && (this.pointer < 0 || !samePosition(origin, this.jumps[this.pointer]))) {
        this.jumps = this.jumps.slice(0, this.pointer + 1);
        this.append(copyPosition(origin));
      }
      let destination = this.pointer;
      for (
        let remaining = Math.max(1, Math.min(100, Math.floor(count)));
        remaining > 0;
        remaining--
      ) {
        const next = destination + direction;
        if (next < 0 || next >= this.jumps.length) break;
        destination = next;
      }
      if (destination === this.pointer) {
        this.jumps = originalJumps;
        this.pointer = originalPointer;
        return;
      }
      this.transient.add(origin);
      try {
        await this.restore(this.jumps[destination], false, check);
        check();
        this.pointer = destination;
      } catch (error) {
        if (check(false)) {
          this.jumps = originalJumps;
          this.pointer = originalPointer;
          await this.restore(origin, false, check).catch(() => {});
        }
        throw error;
      } finally {
        this.transient.delete(origin);
      }
    });
  }

  private append(position: NavigationPosition): void {
    if (!this.jumps.length || !samePosition(this.jumps[this.jumps.length - 1], position))
      this.jumps.push(position);
    if (this.jumps.length > 100) this.jumps.splice(0, this.jumps.length - 100);
    this.pointer = this.jumps.length - 1;
  }

  private record(from: NavigationPosition, to: NavigationPosition): void {
    if (samePosition(from, to)) return;
    this.jumps = this.jumps.slice(0, this.pointer + 1);
    this.append(copyPosition(from));
    this.append(copyPosition(to));
  }

  private start(action: (check: (throwOnFailure?: boolean) => boolean) => Promise<void>): void {
    const generation = ++this.generation;
    const identity = this.identity;
    const check = (throwOnFailure = true) => {
      const valid =
        !this.destroyed &&
        generation === this.generation &&
        identity === this.options.documentIdentity();
      if (!valid && throwOnFailure) throw new Error("移動は取り消されました。");
      return valid;
    };
    const task = Promise.resolve().then(() => {
      check();
      return action(check);
    });
    this.options.waitFor(task, () => {
      if (generation === this.generation) this.generation++;
    });
  }

  private async restore(
    position: NavigationPosition,
    linewise: boolean,
    check: (throwOnFailure?: boolean) => boolean,
  ): Promise<void> {
    check();
    if (!position.valid) throw new Error("移動先は削除されています。");
    const parent = this.cm.cm6;
    if (position.target.kind === "body") {
      focusNativeBody(
        this.options.owner(),
        parent,
        this.lineOffset(parent, position.offset, linewise),
      );
    } else {
      await restoreNativeCell(
        () => this.options.owner(),
        parent,
        () => {
          if (!position.valid || position.target.kind !== "cell")
            throw new Error("移動先は削除されています。");
          return { ...position.target, offset: position.offset, linewise };
        },
        () => {
          check();
        },
      );
    }
    this.options.afterRestore();
    check();
  }

  private lineOffset(view: EditorView, offset: number, linewise: boolean): number {
    offset = Math.max(0, Math.min(offset, view.state.doc.length));
    if (!linewise) return offset;
    const line = view.state.doc.lineAt(offset);
    return line.from + (line.text.match(/^\s*/u)?.[0].length ?? 0);
  }

  reset(): void {
    this.generation++;
    this.options.cancelPending();
    this.marks.clear();
    this.jumps = [];
    this.pointer = -1;
    this.transient.clear();
    this.nativeChanges = [];
    this.identity = this.options.documentIdentity();
  }

  destroy(): void {
    this.destroyed = true;
    this.reset();
    if (this.cm.state.navigationProvider === this.provider)
      this.cm.state.navigationProvider = this.previousProvider;
    sessions.delete(this.cm);
  }
}
