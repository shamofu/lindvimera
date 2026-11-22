import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { BackendHost, EngineBackend } from "../types";
import { createLivePreviewClickExtension, isLivePreviewView } from "../../markdown/live-preview";
import { analyseKeyBindings } from "./policy";
import { NativeExtensions, installDefinitions } from "./extensions";
import { NativePendingHints } from "./hints";
import { NativeTableReplay } from "./table-replay";
import { NativeNavigationManager } from "./navigation";
import { NativeNavigationScope } from "./scope";
import { NativeAdapterLifetime } from "./adapter-lifetime";
import { NativeMacroCoordinator } from "./macros";
import { NativeCommandQueue, NativeExBridge } from "./ex-mapping";
import {
  getNativeCM,
  getNativeVim,
  withMappings,
  type NativeCM,
  type NativeCommand,
  type NativeInput,
  type NativeState,
  type NativeVim,
} from "./native";

interface Session {
  readonly cm: NativeCM;
  readonly view: EditorView;
  readonly vim: NativeVim;
  readonly extensions: NativeExtensions;
  readonly hints: NativePendingHints;
  readonly ex: NativeExBridge;
  readonly queue: NativeCommandQueue;
  readonly macro: NativeMacroCoordinator;
  readonly ownsQueue: boolean;
  readonly modeChanged: (...args: unknown[]) => void;
  mappingSignature: string;
  mappings: NativeCommand[];
  previousCursorColor: string;
  appliedCursorColor?: string;
}

function hasPendingInput(state: NativeState | undefined): boolean {
  const input = state?.inputState;
  return !!(
    state?.expectLiteralNext ||
    input?.operator ||
    input?.keyBuffer?.length ||
    input?.prefixRepeat?.length ||
    input?.motionRepeat?.length ||
    input?.registerName
  );
}

function operatorLabel(input: NativeInput): string {
  if (input.operatorShortcut) return input.operatorShortcut;
  switch (input.operator) {
    case "delete":
      return "d";
    case "yank":
      return "y";
    case "change":
      return "c";
    case "indentAuto":
      return "=";
    case "indent":
      return input.operatorArgs?.indentRight ? ">" : "<";
    case "lindvimera115_surroundAdd":
      return "ys";
    case "lindvimera115_surroundDelete":
      return "ds";
    case "lindvimera115_surroundChange":
      return "cs";
    default:
      return input.operator ?? "";
  }
}

function pendingKeys(state: NativeState | undefined): string {
  const input = state?.inputState;
  if (!input) return "";
  return [
    input.registerName ? `"${input.registerName}` : "",
    input.prefixRepeat?.join("") ?? "",
    input.operator ? operatorLabel(input) : "",
    input.motionRepeat?.join("") ?? "",
    input.keyBuffer?.join("") ?? "",
  ].join("");
}

interface LookupLifetime {
  host?: BackendHost;
  sessions: Map<NativeCM, Session>;
  updateMode?: (cm: NativeCM) => void;
  replay?: NativeTableReplay;
  navigation?: NativeNavigationManager;
}

/** A later plugin may wrap our function. Disposal clears this tiny lifetime
 * object so that its delegating wrapper cannot retain the plugin or editors. */
function createNativeLookup(
  vim: NativeVim,
  previous: NativeVim["findKey"],
  lifetime: LookupLifetime,
): NativeVim["findKey"] {
  return function (this: NativeVim, cm, key, origin) {
    const host = lifetime.host;
    const session = lifetime.sessions.get(cm);
    if (!host?.isActive() || !session || !session.extensions.active())
      return previous.call(this, cm, key, origin);
    const queued = session.queue.intercept(cm, key, origin);
    if (queued) return queued;
    if (key === ".") lifetime.replay?.restore(cm, host, true);
    const settings = host.settings();
    session.extensions.configure();
    const commands = [
      ...session.extensions.commands(key),
      ...(lifetime.navigation?.commands(cm) ?? []),
      ...session.macro.commands(),
      ...session.mappings,
    ];
    const lookupKeys = (cm.state.vim?.inputState.keyBuffer.join("") ?? "") + key;
    const context = cm.state.vim?.insertMode
      ? "insert"
      : cm.state.vim?.inputState.operator
        ? "operatorPending"
        : cm.state.vim?.visualMode
          ? "visual"
          : "normal";
    const userMapped = session.mappings.some(
      (mapping) =>
        mapping.keys === lookupKeys.replace(/^[1-9]\d*/u, "") && mapping.context === context,
    );
    const timeout = vim.getOption?.("insertModeEscKeysTimeout");
    let command: (() => unknown) | undefined;
    try {
      if (vim.setOption && vim.getOption)
        vim.setOption("insertModeEscKeysTimeout", settings.escapeTimeoutMs);
      command = withMappings(vim, commands, () => previous.call(this, cm, key, origin));
    } finally {
      if (vim.setOption && vim.getOption) vim.setOption("insertModeEscKeysTimeout", timeout);
    }
    session.hints.refresh();
    if (!command) return;
    return () => {
      if (!lifetime.host?.isActive() || lifetime.sessions.get(cm) !== session) return;
      if (!userMapped) session.extensions.beforeCommand(key);
      try {
        return command();
      } finally {
        session.extensions.afterCommand();
        if (!cm.state.vim?.insertMode) session.ex.endInsertGroup();
        lifetime.updateMode?.(cm);
      }
    };
  };
}

/** Builtin integration never constructs an adapter or enters/leaves Vim mode. */
export function createBackend(host: BackendHost): EngineBackend {
  if (typeof window === "undefined" || !getNativeVim(window))
    throw new Error("Obsidian 1.15 の内蔵 CM6 Vim API を利用できません。");
  let disposed = false;
  const views = new Set<EditorView>();
  const sessions = new Map<NativeCM, Session>();
  const macros = new Map<NativeCommandQueue, NativeMacroCoordinator>();
  const tableReplay = new NativeTableReplay();
  const navigation = new NativeNavigationManager(host);
  const scope = new NativeNavigationScope(host);
  const adapterLifetime = new NativeAdapterLifetime();
  const lifetime: LookupLifetime = { host, sessions, updateMode, replay: tableReplay, navigation };
  const wrappers = new Map<
    NativeVim,
    { previous: NativeVim["findKey"]; owned: NativeVim["findKey"] }
  >();
  let unavailableReported = false;

  function updateMode(cm: NativeCM): void {
    if (!disposed && host.isActive()) {
      tableReplay.capture(cm, host);
      const session = sessions.get(cm);
      const state = cm.state.vim;
      if (cm.cm6.dom.ownerDocument.activeElement?.closest(".cm-editor") === cm.cm6.dom) {
        const mode = state?.insertMode
          ? cm.state.overwrite
            ? "REPLACE"
            : "INSERT"
          : state?.visualMode
            ? state.visualBlock
              ? "VISUAL BLOCK"
              : state.visualLine
                ? "VISUAL LINE"
                : "VISUAL"
            : "NORMAL";
        const pending = hasPendingInput(state) ? state?.status || pendingKeys(state) : "";
        const macro = session?.vim.getVimGlobalState_?.()?.macroModeState;
        const recording =
          macro?.isRecording && macro.latestRegister ? `recording @${macro.latestRegister}` : "";
        host.reportMode([mode, pending, recording].filter(Boolean).join(" · "));
      }
      session?.hints.refresh();
    }
  }

  function installWrapper(vim: NativeVim): void {
    if (wrappers.has(vim)) return;
    installDefinitions(vim);
    const previous = vim.findKey;
    const owned = createNativeLookup(vim, previous, lifetime);
    vim.findKey = owned;
    wrappers.set(vim, { previous, owned });
  }

  function configure(session: Session): void {
    session.extensions.configure();
    session.hints.refresh();
    const settings = host.settings();
    const signature = JSON.stringify(settings);
    if (!host.isActive()) session.ex.cancelPending();
    if (signature !== session.mappingSignature) {
      session.mappingSignature = signature;
      session.mappings = [
        ...settings.escapeSequences.map((keys) => ({
          keys,
          type: "keyToKey" as const,
          context: "insert",
          toKeys: "<Esc>",
          noremap: false,
        })),
        ...analyseKeyBindings(settings.keyBindings, settings).active.map((binding) =>
          binding.to.startsWith(":") || /:.*<CR>/iu.test(binding.to)
            ? session.ex.mapping(binding)
            : {
                keys: binding.from,
                type: "keyToKey" as const,
                context: binding.mode,
                toKeys: binding.to,
                noremap: false,
              },
        ),
      ];
    }
    session.view.dom.classList.toggle(
      "lindvimera-custom-cursor",
      Boolean(settings.cursorColor && host.isActive()),
    );
    const style = session.view.dom.style;
    if (settings.cursorColor && host.isActive()) {
      session.appliedCursorColor = settings.cursorColor;
      style.setProperty("--lindvimera-cursor-color", settings.cursorColor);
    } else if (
      session.appliedCursorColor &&
      style.getPropertyValue("--lindvimera-cursor-color") === session.appliedCursorColor
    ) {
      if (session.previousCursorColor)
        style.setProperty("--lindvimera-cursor-color", session.previousCursorColor);
      else style.removeProperty("--lindvimera-cursor-color");
      session.appliedCursorColor = undefined;
    }
    updateMode(session.cm);
  }

  function detach(cm: NativeCM): void {
    const session = sessions.get(cm);
    if (!session) return;
    session.extensions.dispose();
    session.hints.destroy();
    session.ex.dispose();
    if (session.macro.detach(cm)) {
      session.macro.dispose();
      macros.delete(session.queue);
    }
    if (session.ownsQueue) session.queue.dispose();
    navigation.detach(cm);
    cm.off("vim-mode-change", session.modeChanged);
    cm.off("vim-command-done", session.modeChanged);
    session.view.dom.classList.remove("lindvimera-custom-cursor");
    const style = session.view.dom.style;
    if (
      session.appliedCursorColor &&
      style.getPropertyValue("--lindvimera-cursor-color") === session.appliedCursorColor
    ) {
      if (session.previousCursorColor)
        style.setProperty("--lindvimera-cursor-color", session.previousCursorColor);
      else style.removeProperty("--lindvimera-cursor-color");
    }
    sessions.delete(cm);
  }

  function attach(view: EditorView): void {
    if (disposed || !views.has(view)) return;
    const cm = getNativeCM(view);
    for (const session of sessions.values())
      if (session.view === view && session.cm !== cm) detach(session.cm);
    if (!cm || sessions.has(cm)) return;
    const owner = view.dom.ownerDocument.defaultView;
    const vim = owner && getNativeVim(owner);
    if (!vim) {
      if (!unavailableReported)
        host.reportError(
          "Obsidian の内蔵 Vim API を利用できません。内蔵エンジンを開始できませんでした。",
        );
      unavailableReported = true;
      return;
    }
    installWrapper(vim);
    adapterLifetime.track(cm, vim);
    navigation.attach(cm, vim);
    const sharedQueue = navigation.queue(cm);
    const queue =
      sharedQueue ??
      new NativeCommandQueue({
        liveTargetCM: () => (sessions.has(cm) ? cm : undefined),
        isActive: () => !disposed && host.isActive(),
        dispatch: (target, key, origin) => vim.handleKey(target, key, origin),
        onError: (error) =>
          host.reportError(error instanceof Error ? error.message : String(error)),
      });
    const documentIdentity = () => {
      let identity: unknown = view;
      host.app.workspace?.iterateAllLeaves?.((leaf) => {
        const document = leaf.view as unknown as { file?: unknown; editMode?: { cm?: EditorView } };
        if (document.editMode?.cm?.dom.contains(view.dom)) identity = document.file;
      });
      return identity;
    };
    let macro = macros.get(queue);
    if (!macro) {
      macro = new NativeMacroCoordinator(vim, queue);
      macros.set(queue, macro);
    }
    macro.attach(cm);
    const ex = new NativeExBridge(
      cm,
      vim,
      queue,
      () => !disposed && host.isActive(),
      documentIdentity,
    );
    const extensions = new NativeExtensions(cm, vim, host, queue, () => ex.beginInsertGroup());
    const modeChanged = () => updateMode(cm);
    const session: Session = {
      cm,
      view,
      vim,
      extensions,
      ex,
      queue,
      macro,
      ownsQueue: !sharedQueue,
      hints: new NativePendingHints(cm, vim, host),
      modeChanged,
      mappingSignature: "",
      mappings: [],
      previousCursorColor: view.dom.style.getPropertyValue("--lindvimera-cursor-color"),
    };
    sessions.set(cm, session);
    tableReplay.restore(cm, host);
    cm.on("vim-mode-change", modeChanged);
    cm.on("vim-command-done", modeChanged);
    configure(session);
    scope.refresh();
  }

  function refresh(): void {
    if (disposed) return;
    navigation.refresh();
    scope.refresh();
    for (const view of views) {
      attach(view);
      const cm = getNativeCM(view);
      if (cm) {
        const session = sessions.get(cm);
        if (session) configure(session);
      }
    }
  }

  host.registerEditorExtension([
    EditorView.editorAttributes.of(() =>
      !disposed && host.isActive() && host.settings().cursorColor
        ? { class: "lindvimera-custom-cursor" }
        : null,
    ),
    createLivePreviewClickExtension({
      isActive: () => !disposed && host.isActive(),
      isLivePreview: isLivePreviewView,
      isInsertMode: (view) => getNativeCM(view)?.state.vim?.insertMode === true,
    }),
    ViewPlugin.fromClass(
      class {
        constructor(readonly view: EditorView) {
          views.add(view);
          // Host Vim may be another plugin constructed later in this same update.
          queueMicrotask(() => attach(view));
        }
        update(update: ViewUpdate): void {
          navigation.update(update);
          sessions.get(getNativeCM(this.view)!)?.ex.onUpdate(update);
          if (update.focusChanged) {
            const cm = getNativeCM(this.view);
            if (cm) updateMode(cm);
          }
          if (update.docChanged) sessions.get(getNativeCM(this.view)!)?.extensions.cancel();
          sessions.get(getNativeCM(this.view)!)?.hints.refresh();
          queueMicrotask(() => attach(this.view));
        }
        destroy(): void {
          views.delete(this.view);
          for (const session of sessions.values())
            if (session.view === this.view) detach(session.cm);
        }
      },
    ),
    EditorView.baseTheme({
      ".cm-vimCursorLayer .cm-cursor": {
        backgroundColor: "var(--lindvimera-cursor-color, var(--text-normal))",
      },
    }),
  ]);

  const capabilities = Object.freeze({
    nativeCore: true,
    japaneseMotions: true,
    japaneseTextObjects: true,
    markdownMotions: true,
    markdownTextObjects: true,
    surround: true,
    folding: true,
    tables: "native-independent-adapters",
    markdownEditing: "native-smart-lists-with-markdown-content-start-and-open-above",
  });
  const runtime = {
    engine: "builtin",
    identity: "window.CodeMirrorAdapter.Vim",
    get Vim(): NativeVim | undefined {
      return typeof window === "undefined" ? undefined : getNativeVim(window);
    },
    getCM: getNativeCM,
    editorSession(view: EditorView): object | undefined {
      const cm = getNativeCM(view);
      const session = cm && sessions.get(cm);
      return (
        session && {
          cm: session.cm,
          view: session.view,
          engine: "builtin",
          state: session.cm.state.vim,
          capabilities,
        }
      );
    },
    capabilities,
    status: () => ({
      available: wrappers.size > 0,
      active: !disposed && host.isActive(),
      editors: sessions.size,
      disposed,
    }),
    settled: () =>
      Promise.all([
        navigation.settled(),
        ...[...sessions.values()].flatMap((session) => [
          session.extensions.settled(),
          session.queue.settled(),
        ]),
      ]),
  };

  return {
    runtime,
    refresh,
    flush: refresh,
    applySettings: refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.host = undefined;
      lifetime.updateMode = undefined;
      lifetime.replay = undefined;
      lifetime.navigation = undefined;
      for (const cm of sessions.keys()) detach(cm);
      for (const [vim, wrapper] of wrappers)
        if (vim.findKey === wrapper.owned) vim.findKey = wrapper.previous;
      wrappers.clear();
      tableReplay.clear();
      navigation.dispose();
      scope.dispose();
      adapterLifetime.dispose();
      views.clear();
    },
  };
}
