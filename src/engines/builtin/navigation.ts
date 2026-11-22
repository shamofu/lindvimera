import type { EditorView, ViewUpdate } from "@codemirror/view";
import { NavigationTracker, type NavigationAdapter, type Pos } from "../../navigation/tracker";
import type { BackendHost } from "../types";
import { NativeCommandQueue } from "./ex-mapping";
import {
  getNativeCM,
  resolveEditorLeaf,
  type NativeCM,
  type NativeCommand,
  type NativeDocumentView,
  type NativeVim,
} from "./native";

interface Group {
  document: NativeDocumentView;
  parent: EditorView;
  adapter: NavigationAdapter;
  tracker: NavigationTracker;
  queue: NativeCommandQueue;
  vim: NativeVim;
  active(): boolean;
}

const memberships = new WeakMap<NativeCM, Group>();
const defined = new WeakSet<NativeVim>();
const prefix = "lindvimera115_navigation_";

function defineCommands(vim: NativeVim): void {
  if (defined.has(vim)) return;
  vim.defineAction(prefix + "mark", (cm, args) => {
    const group = memberships.get(cm);
    if (!group) return;
    const name = args.selectedCharacter ?? "";
    group.tracker.setMark(name);
    // Preserve native same-surface operator/Ex mark lookup as well.
    const adapter = cm as NativeCM & { setBookmark?(position: Pos): { clear?(): void } };
    const state = cm.state.vim;
    if (adapter.setBookmark && state?.marks) {
      state.marks[name]?.clear?.();
      state.marks[name] = adapter.setBookmark(cm.getCursor());
    }
  });
  vim.defineAction(prefix + "go", (cm, args) =>
    memberships.get(cm)?.tracker.goToMark(args.selectedCharacter ?? "", !!args.linewise),
  );
  vim.defineAction(prefix + "walk", (cm, args) =>
    memberships.get(cm)?.tracker.walk(args.forward ? 1 : -1, args.repeat ?? 1),
  );
  defined.add(vim);
}

interface JumpList {
  add: (cm: NativeCM, from: Pos, to: Pos) => unknown;
}

/** Native jump recording stays intact; our source coordinates survive cell recreation. */
function observeJumps(previous: JumpList["add"]): JumpList["add"] {
  return function (this: JumpList, cm, from, to) {
    const group = memberships.get(cm);
    if (group?.active()) group.adapter.state.navigationProvider?.recordJump(from, to);
    return previous.call(this, cm, from, to);
  };
}

/** One logical navigation/continuation lifetime per Markdown pane and document. */
export class NativeNavigationManager {
  private groups = new Map<EditorView, Group>();
  private adapters = new Map<NativeCM, Group>();
  private observers = new Map<JumpList, { before: JumpList["add"]; owned: JumpList["add"] }>();
  private disposed = false;
  private readonly mappings: NativeCommand[] = [
    ...[..."abcdefghijklmnopqrstuvwxyz"].flatMap((name) => [
      {
        keys: `m${name}`,
        type: "action" as const,
        action: prefix + "mark",
        actionArgs: { selectedCharacter: name },
        context: "normal",
      },
      {
        keys: `'${name}`,
        type: "action" as const,
        action: prefix + "go",
        actionArgs: { selectedCharacter: name, linewise: true },
        context: "normal",
      },
      {
        keys: `\`${name}`,
        type: "action" as const,
        action: prefix + "go",
        actionArgs: { selectedCharacter: name, linewise: false },
        context: "normal",
      },
    ]),
    {
      keys: "<C-o>",
      type: "action",
      action: prefix + "walk",
      actionArgs: { forward: false },
      context: "normal",
    },
    {
      keys: "<C-i>",
      type: "action",
      action: prefix + "walk",
      actionArgs: { forward: true },
      context: "normal",
    },
  ];

  constructor(private host: BackendHost) {}

  attach(cm: NativeCM, vim: NativeVim): void {
    if (this.disposed || this.adapters.has(cm)) return;
    const match = resolveEditorLeaf(this.host.app, cm.cm6);
    if (!match) return;
    const { document, parent } = match;
    let group = this.groups.get(parent);
    if (!group) {
      const documentView = document;
      const current = () => getNativeCM(documentView.editMode?.tableCell?.cm ?? parent);
      const adapter: NavigationAdapter = {
        cm6: parent,
        state: {},
        getEditingView: () => documentView.editMode?.tableCell?.cm ?? parent,
        getCursor: () => current()?.getCursor() ?? { line: 0, ch: 0 },
        indexFromPos: (pos) => current()?.indexFromPos(pos) ?? 0,
        posFromIndex: (offset) => current()?.posFromIndex(offset) ?? { line: 0, ch: 0 },
      };
      const queue = new NativeCommandQueue({
        liveTargetCM: current,
        isActive: () => !this.disposed && this.host.isActive(),
        dispatch: (target, key, origin) => vim.handleKey(target, key, origin),
        onError: (error) =>
          this.host.reportError(error instanceof Error ? error.message : String(error)),
      });
      const tracker = new NavigationTracker(adapter, {
        owner: () => documentView.editMode,
        documentIdentity: () => documentView.file,
        waitFor: (task, cancel) =>
          queue.waitFor(
            task.catch((error) => {
              if (!this.disposed)
                this.host.reportError(error instanceof Error ? error.message : String(error));
              throw error;
            }),
            cancel,
          ),
        cancelPending: () => queue.cancel(),
        afterRestore: () => {
          const target = current();
          if (target?.state.vim && !target.state.vim.visualMode) {
            const head = target.getCursor();
            target.state.vim.sel = { anchor: { ...head }, head: { ...head } };
          }
        },
      });
      group = {
        document,
        parent,
        adapter,
        tracker,
        queue,
        vim,
        active: () => !this.disposed && this.host.isActive(),
      };
      this.groups.set(parent, group);
    }
    defineCommands(vim);
    const global = (vim.getVimGlobalState_ as (() => { jumpList?: JumpList }) | undefined)?.call(
      vim,
    );
    const jumpList = global?.jumpList;
    if (jumpList && !this.observers.has(jumpList)) {
      const before = jumpList.add;
      const owned = observeJumps(before);
      jumpList.add = owned;
      this.observers.set(jumpList, { before, owned });
    }
    this.adapters.set(cm, group);
    memberships.set(cm, group);
  }

  commands(cm: NativeCM): NativeCommand[] {
    return this.host.isActive() && this.adapters.has(cm) ? this.mappings : [];
  }

  queue(cm: NativeCM): NativeCommandQueue | undefined {
    return this.adapters.get(cm)?.queue;
  }

  refresh(): void {
    if (!this.host.isActive()) for (const group of this.groups.values()) group.queue.cancel();
  }

  update(update: ViewUpdate): void {
    for (const group of this.groups.values())
      if (update.view === group.parent || update.view === group.document.editMode?.tableCell?.cm)
        group.tracker.update(update);
  }

  detach(cm: NativeCM): void {
    const group = this.adapters.get(cm);
    this.adapters.delete(cm);
    memberships.delete(cm);
    if (group?.parent === cm.cm6) this.removeGroup(group);
  }

  private removeGroup(group: Group): void {
    group.tracker.destroy();
    group.queue.dispose();
    this.groups.delete(group.parent);
    for (const [cm, candidate] of this.adapters)
      if (candidate === group) {
        this.adapters.delete(cm);
        memberships.delete(cm);
      }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const group of this.groups.values()) this.removeGroup(group);
    for (const [list, observer] of this.observers)
      if (list.add === observer.owned) list.add = observer.before;
    this.observers.clear();
  }

  settled(): Promise<unknown> {
    return Promise.all([...this.groups.values()].map((group) => group.queue.settled()));
  }
}
