import { ItemView, MarkdownView, TFile, apiVersion, type WorkspaceLeaf } from "obsidian";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, redo, undoDepth } from "@codemirror/commands";
import { getCM, Vim } from "@replit/codemirror-vim";
import type LindvimeraPlugin from "../main";
import { WordBoundaryCache, wordSpans } from "../word";
import type { LinderaMode } from "../word/service";
import { editorSession, lindvimeraEditor } from "../runtime/editor";
import { DEFAULT_SETTINGS, type LindvimeraSettings } from "../settings";
import { measureEditorPerformance } from "./performance";
import { resolveNativeTable } from "../table/native-adapter";
import { parseMarkdownTable } from "../table/source";
import { runHostRegression } from "./host-regression";

export const PROBE_VIEW_TYPE = "lindvimera-input-probe";
export const ACCEPTANCE_REPORT_PATH = "Lindvimera acceptance.json";
const modeFixture = "関西国際空港限定トートバッグ";
type Engine = NonNullable<ReturnType<typeof getCM>>;
interface Check {
  passed: boolean;
  detail: string;
  observedAt: string;
}
interface Report {
  schemaVersion: 3;
  behavior: "cell-editor-v1";
  scope: "non-ime";
  environment: { obsidian: string; electron: string | undefined; platform: string; plugin: string };
  checks: Record<string, Check>;
  physicalInput?: { key: string; code: string; trusted: boolean; composing: boolean }[];
}

function keys(cm: Engine, text: string): void {
  for (const key of text.match(/<[^>]+>|./gu) ?? [])
    cm.operation(() => Vim.handleKey(cm, key, "user"));
}

/** Synthetic keys have no default text insertion; explicitly supply that browser operation. */
function input(view: EditorView, text: string): void {
  for (const key of text) {
    const event = new KeyboardEvent("keydown", {
      key,
      code: `Key${key.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);
    if (!event.defaultPrevented) insertBrowserText(view, key);
  }
}

function insertBrowserText(view: EditorView, text: string): void {
  const before = new InputEvent("beforeinput", {
    data: text,
    inputType: "insertText",
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(before);
  if (!before.defaultPrevented)
    view.dispatch(view.state.replaceSelection(text), {
      annotations: Transaction.userEvent.of("input.type"),
    });
}

function keyboardEvent(token: string): KeyboardEvent {
  let key = token;
  let ctrlKey = false;
  let shiftKey = false;
  if (/^<C-.$/i.test(token.slice(0, -1))) {
    key = token.slice(3, -1);
    ctrlKey = true;
  }
  if (token === "<Esc>") key = "Escape";
  if (token === "<Tab>" || token === "<S-Tab>") key = "Tab";
  if (token === "<S-Tab>") shiftKey = true;
  if (token === "<Enter>" || token === "<CR>") key = "Enter";
  if (["<Left>", "<Right>", "<Up>", "<Down>"].includes(token)) key = `Arrow${token.slice(1, -1)}`;
  if (/^[A-Z]$/.test(key)) shiftKey = true;
  const punctuation: Record<string, [string, boolean]> = {
    '"': ["Quote", true],
    "'": ["Quote", false],
    ")": ["Digit0", true],
    "(": ["Digit9", true],
    "*": ["Digit8", true],
    $: ["Digit4", true],
    "^": ["Digit6", true],
    "]": ["BracketRight", false],
    "[": ["BracketLeft", false],
  };
  const code = punctuation[key]?.[0] ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key);
  shiftKey ||= punctuation[key]?.[1] ?? false;
  return new KeyboardEvent("keydown", {
    key,
    code,
    ctrlKey,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
}

function requireCheck(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

function requireVisibleCandidate(view: EditorView, text: string): void {
  const candidate = view.contentDOM.querySelector(".lindvimera-escape-preview");
  requireCheck(candidate?.textContent === text, "Escape candidate was not rendered immediately.");
  const box = candidate.getBoundingClientRect();
  requireCheck(box.width > 0 && box.height > 0, "Escape candidate has no visible layout.");
  const caret = view.coordsAtPos(view.state.selection.main.head);
  requireCheck(
    caret && caret.left >= box.right - 1,
    "Insertion caret did not follow the candidate.",
  );
}

function requireRenderedIn(
  element: HTMLElement | null,
  container: HTMLElement,
  label: string,
): void {
  requireCheck(element && container.contains(element), `${label} is not in the active cell.`);
  let ancestor: HTMLElement | null = element;
  while (ancestor) {
    const style = container.ownerDocument.defaultView!.getComputedStyle(ancestor);
    requireCheck(
      style.display !== "none" && !["hidden", "collapse"].includes(style.visibility),
      `${label} is hidden by ${ancestor.className || ancestor.tagName}.`,
    );
    if (ancestor === container) break;
    ancestor = ancestor.parentElement;
  }
  requireCheck(ancestor === container, `${label} is detached from the active cell.`);
  const bounds = element.getBoundingClientRect();
  requireCheck(bounds.width > 0 && bounds.height > 0, `${label} has no rendered bounds.`);
}

/** Runs only in the opt-in disposable Vault. IME control/composition is outside the product scope. */
export class ProbeView extends ItemView {
  private editor?: EditorView;
  private status!: HTMLElement;
  private editorContainer!: HTMLElement;
  private report: Report;
  private busy = false;
  private editorSettings: LindvimeraSettings = { ...DEFAULT_SETTINGS };
  private physicalEditor?: EditorView;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: LindvimeraPlugin,
  ) {
    super(leaf);
    this.report = {
      schemaVersion: 3,
      behavior: "cell-editor-v1",
      scope: "non-ime",
      environment: {
        obsidian: apiVersion,
        electron: process.versions.electron,
        platform: process.platform,
        plugin: plugin.manifest.version,
      },
      checks: {},
    };
  }

  getViewType(): string {
    return PROBE_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Lindvimera regression workbench";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("lindvimera-probe");
    this.contentEl.createEl("h2", { text: "Lindvimera — regression workbench" });
    this.contentEl.createEl("p", {
      text: "Tests run the production plugin and real Obsidian editor APIs in this disposable Vault. ASCII typing uses key events and CodeMirror transactions. IME support/testing is excluded.",
    });
    const controls = this.contentEl.createDiv({ cls: "probe-controls" });
    this.button(controls, "Run engine regression", () => this.runEngineRegression());
    this.button(controls, "Open table fixture", async () => {
      await this.plugin.app.workspace.openLinkText("Native table", "", true);
    });
    this.button(controls, "Run native table regression", () => this.runNativeRegression());
    this.button(controls, "Run host regression", () => this.runHostRegression());
    this.button(controls, "Run performance", () => this.runPerformanceRegression());
    this.button(controls, "Prepare physical input", () => this.preparePhysicalInput());
    this.button(controls, "Verify physical input", () => this.verifyPhysicalInput());
    this.contentEl.createEl("p", {
      text: "Native test: open Native table.md in Live Preview and focus a cell first. Keep this workbench in another pane, or invoke the plugin's native regression command.",
    });
    this.editorContainer = this.contentEl.createDiv({ cls: "probe-editor" });
    this.status = this.contentEl.createEl("pre", { cls: "probe-status" });
    this.resetEditor("Lindvimera 日本語テスト\nsecond line");
    await this.save();
  }

  private button(parent: HTMLElement, label: string, callback: () => Promise<void>): void {
    const button = parent.createEl("button", { text: label });
    this.registerDomEvent(button, "click", () => {
      if (this.busy) return;
      this.busy = true;
      void callback()
        .catch((error: unknown) => {
          this.status.textContent = String(error);
        })
        .finally(() => {
          this.busy = false;
        });
    });
  }

  async preparePhysicalInput(): Promise<void> {
    const { view } = this.resetEditor("");
    this.physicalEditor = view;
    this.report.physicalInput = [];
    delete this.report.checks["physical-keyboard-input"];
    this.registerDomEvent(
      view.dom.ownerDocument,
      "keydown",
      (event) => {
        if (
          this.physicalEditor !== view ||
          !(event.target instanceof Node) ||
          !view.contentDOM.contains(event.target)
        )
          return;
        this.report.physicalInput!.push({
          key: event.key,
          code: event.code,
          trusted: event.isTrusted,
          composing: event.isComposing,
        });
      },
      true,
    );
    this.editorSettings.escapeTimeoutMs = 60000;
    editorSession(view)!.configure();
    await this.save();
    view.focus();
    this.status.textContent =
      "Type iabcjj using OS keys (60-second escape window for inspected input), then Verify physical input.";
  }

  async verifyPhysicalInput(): Promise<void> {
    await this.check("physical-keyboard-input", () => {
      const view = this.physicalEditor;
      requireCheck(view && view === this.editor, "Prepare physical input before verifying it.");
      const events = this.report.physicalInput ?? [];
      requireCheck(
        events.map((event) => event.key).join("") === "iabcjj" &&
          events.every((event) => event.trusted && !event.composing),
        "Expected trusted, non-IME iabcjj key events delivered to the prepared editor.",
      );
      const cm = getCM(view)!;
      requireCheck(
        cm.getValue() === "abc" && !cm.state.vim?.insertMode,
        "OS keys did not produce abc in Normal mode.",
      );
      requireCheck(
        Vim.getRegisterController().getRegister(".").toString() === "abc",
        "OS escape keys entered the insert register.",
      );
      requireCheck(undo(view) && cm.getValue() === "", "OS input was not one Undo event.");
      requireCheck(redo(view) && cm.getValue() === "abc", "OS input Redo failed.");
    });
    this.physicalEditor = undefined;
  }

  getPhysicalInputCount(): number {
    return this.report.physicalInput?.length ?? 0;
  }

  /** Import checks driven by trusted CDP/OS keys before the workbench was enabled. */
  async recordKeyboardRegression(checks: Record<string, Check>): Promise<void> {
    Object.assign(this.report.checks, checks);
    await this.save();
  }

  private resetEditor(text: string, productionWords = false): { view: EditorView; cm: Engine } {
    this.editor?.destroy();
    this.editorContainer.empty();
    this.editorSettings = { ...DEFAULT_SETTINGS, escapeSequences: ["jj"], keyBindings: [] };
    const view = (this.editor = new EditorView({
      parent: this.editorContainer,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          lindvimeraEditor({
            settings: () => this.editorSettings,
            owner: () => undefined,
            wordSegmenter: productionWords
              ? () => this.plugin.wordSegmenter(this.editorSettings.linderaMode)
              : undefined,
          }),
        ],
      }),
    }));
    return { view, cm: getCM(view)! };
  }

  private async checkLinderaMode(
    cm: Engine,
    mode: LinderaMode,
    settle: () => Promise<void> = () => Promise.resolve(),
  ): Promise<void> {
    const segmenter = this.plugin.wordSegmenter(mode);
    requireCheck(
      segmenter.id === `lindera-ipadic-6.0.0-${mode}`,
      `The ${mode} test is using ${segmenter.id} instead of the bundled Lindera runtime.`,
    );
    const spans = wordSpans(
      modeFixture,
      false,
      new WordBoundaryCache(512, 262_144, true, segmenter),
    );
    requireCheck(
      spans[0].to === (mode === "normal" ? 6 : 2),
      `${mode} did not retain the expected compound-word granularity.`,
    );
    requireCheck(cm.getValue() === modeFixture, "The mode fixture has unexpected input text.");
    keys(cm, "0w");
    requireCheck(
      cm.getCursor().line === 0 && cm.getCursor().ch === spans[1].from,
      `w did not use the selected ${mode} boundaries.`,
    );
    keys(cm, "0ciw");
    await settle();
    requireCheck(cm.state.vim?.insertMode, `ciw did not enter Insert in ${mode}.`);
    insertBrowserText(cm.getEditingView(), "new");
    keys(cm, "<Esc>");
    await settle();
    const edited = `new${modeFixture.slice(spans[0].to)}`;
    requireCheck(cm.getValue() === edited, `ciw changed the wrong ${mode} range.`);
    keys(cm, "u");
    await settle();
    requireCheck(cm.getValue() === modeFixture, `${mode} ciw did not undo as one edit.`);
    keys(cm, "0.");
    await settle();
    requireCheck(
      cm.getValue() === edited && !cm.state.vim?.insertMode,
      `Dot did not replay the ${mode} word change.`,
    );
    keys(cm, "u");
    await settle();
    requireCheck(cm.getValue() === modeFixture, `${mode} dot replay did not undo atomically.`);

    const first = modeFixture.slice(0, spans[0].to);
    const rest = modeFixture.slice(spans[0].to);
    keys(cm, '0"byiw');
    requireCheck(
      Vim.getRegisterController().getRegister("b").toString() === first &&
        cm.getValue() === modeFixture,
      `The named register did not receive the ${mode} word.`,
    );
    keys(cm, "0ysiw)");
    await settle();
    requireCheck(cm.getValue() === `(${first})${rest}`, `Surround used the wrong ${mode} word.`);
    keys(cm, "u");
    await settle();
    requireCheck(cm.getValue() === modeFixture, `${mode} Surround did not undo atomically.`);

    keys(cm, "0qcdiwq");
    await settle();
    requireCheck(cm.getValue() === rest, `The recorded macro deleted the wrong ${mode} word.`);
    keys(cm, "u");
    await settle();
    requireCheck(cm.getValue() === modeFixture, `${mode} macro recording did not undo atomically.`);
    keys(cm, "0@c");
    await settle();
    requireCheck(
      cm.getValue() === rest && !cm.state.vim?.insertMode,
      `Macro replay deleted the wrong ${mode} word.`,
    );
    keys(cm, "u");
    await settle();
    requireCheck(cm.getValue() === modeFixture, `${mode} macro replay did not undo atomically.`);

    const emoji = "👩🏽‍💻";
    keys(cm, "0i");
    insertBrowserText(cm.getEditingView(), `${emoji}e\u0301`);
    keys(cm, "<Esc>0l");
    requireCheck(cm.getCursor().ch === emoji.length, `${mode} l split a joined emoji.`);
    keys(cm, "l");
    requireCheck(cm.getCursor().ch === emoji.length + 2, `${mode} l split a combining character.`);
    keys(cm, "h");
    requireCheck(cm.getCursor().ch === emoji.length, `${mode} h split a combining character.`);
    keys(cm, "h");
    requireCheck(cm.getCursor().ch === 0, `${mode} h split a joined emoji.`);
    keys(cm, "u");
    await settle();
    requireCheck(
      cm.getValue() === modeFixture && !cm.state.vim?.insertMode,
      `${mode} grapheme check did not restore its fixture in Normal mode.`,
    );
  }

  private async check(name: string, callback: () => void | Promise<void>): Promise<void> {
    try {
      await callback();
      this.report.checks[name] = {
        passed: true,
        detail: "All assertions passed.",
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.report.checks[name] = {
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
        observedAt: new Date().toISOString(),
      };
    }
    await this.save();
  }

  async runEngineRegression(): Promise<void> {
    await this.check("ascii-escape-recording", () => {
      const { view, cm } = this.resetEditor("");
      keys(cm, "i");
      input(view, "abcj");
      requireVisibleCandidate(view, "j");
      requireCheck(cm.getValue() === "abc", "Candidate entered the document before resolution.");
      input(view, "j");
      requireCheck(
        !view.contentDOM.querySelector(".lindvimera-escape-preview"),
        "Completed escape left its preview behind.",
      );
      requireCheck(
        cm.getValue() === "abc" && !cm.state.vim?.insertMode,
        "iabcjj did not exit with exactly abc.",
      );
      requireCheck(
        Vim.getRegisterController().getRegister(".").toString() === "abc",
        "Escape keys entered the final-insert register.",
      );
      keys(cm, ".");
      requireCheck(
        cm.getValue() === "ababcc",
        "Dot did not replay insertion without escape characters.",
      );
    });
    await this.check("macro-independent-of-escape-setting", () => {
      const { view, cm } = this.resetEditor("");
      keys(cm, "qaA");
      input(view, "abcjj");
      keys(cm, "q");
      requireCheck(
        !Vim.getRegisterController().getRegister("a").keyBuffer.join("").includes("jj"),
        "Macro contains escape characters.",
      );
      this.editorSettings.escapeSequences = [];
      editorSession(view)?.configure();
      keys(cm, "@a");
      requireCheck(
        cm.getValue() === "abcabc" && !cm.state.vim?.insertMode,
        "Macro changed after escape keys were disabled.",
      );
    });
    await this.check("body-change-single-undo", () => {
      const { view, cm } = this.resetEditor("old next");
      keys(cm, "cw");
      input(view, "newjj");
      requireCheck(cm.getValue() === "new next", "Change plus escape produced wrong text.");
      requireCheck(
        undo(view) && cm.getValue() === "old next",
        "One Undo did not restore the entire change.",
      );
      requireCheck(
        redo(view) && cm.getValue() === "new next",
        "One Redo did not replay the entire change.",
      );
    });
    await this.check("word-punctuation-stops", () => {
      for (const japanese of [true, false]) {
        for (const punctuation of ["。", "！？"]) {
          const first = `今日は良い天気です${punctuation}`;
          const { view, cm } = this.resetEditor(`${first}\n次の行です。`);
          this.editorSettings.japanese = japanese;
          editorSession(view)!.configure();
          const stop = first.length - punctuation.length;
          cm.setCursor({ line: 0, ch: stop - 1 });
          keys(cm, "w");
          requireCheck(
            cm.getCursor().line === 0 && cm.getCursor().ch === stop,
            `w skipped sentence punctuation with Japanese ${japanese}.`,
          );
          keys(cm, "w");
          requireCheck(
            cm.getCursor().line === 1 && cm.getCursor().ch === 0,
            `w did not leave the punctuation run with Japanese ${japanese}.`,
          );
          keys(cm, "ge");
          requireCheck(
            cm.getCursor().line === 0 && cm.getCursor().ch === first.length - 1,
            `ge did not return to the punctuation end with Japanese ${japanese}.`,
          );
        }
        const first = "今日は良い天気です";
        const { view, cm } = this.resetEditor(`${first}\n次の行`);
        this.editorSettings.japanese = japanese;
        editorSession(view)!.configure();
        cm.setCursor({ line: 0, ch: first.length - 1 });
        keys(cm, "w");
        requireCheck(
          cm.getCursor().line === 1 && cm.getCursor().ch === 0,
          `w added an extra stop to an unpunctuated line with Japanese ${japanese}.`,
        );
      }
    });
    await this.check("word-objects-vim-parity", () => {
      for (const japanese of [true, false]) {
        for (const object of ["w", "W"]) {
          for (const [text, command, expected] of [
            ["\nnext", `di${object}`, "\nnext"],
            ["foo\n  bar", `d2i${object}`, "bar"],
            ["foo\n\nbar", `d2a${object}`, ""],
          ]) {
            const { view, cm } = this.resetEditor(text);
            this.editorSettings.japanese = japanese;
            editorSession(view)!.configure();
            keys(cm, command);
            requireCheck(
              cm.getValue() === expected,
              `${command} returned ${JSON.stringify(cm.getValue())} for ${JSON.stringify(text)} with Japanese ${japanese}.`,
            );
          }
          for (const [offset, command, expected] of [
            [0, `vi${object}i${object}`, "foo "],
            [0, `vi${object}a${object}`, "foo bar"],
            [8, `vi${object}oi${object}`, " baz"],
            [8, `vi${object}oa${object}`, "bar baz"],
          ] as const) {
            const { view, cm } = this.resetEditor("foo bar baz");
            this.editorSettings.japanese = japanese;
            editorSession(view)!.configure();
            cm.setCursor({ line: 0, ch: offset });
            keys(cm, command);
            requireCheck(
              cm.getSelection() === expected,
              `${command} selected ${JSON.stringify(cm.getSelection())} instead of ${JSON.stringify(expected)} with Japanese ${japanese}.`,
            );
          }
        }
      }
    });
    await this.check("lindera-mode-editing", async () => {
      await this.plugin.wordsReady;
      for (const mode of ["normal", "decompose"] as const) {
        const { view, cm } = this.resetEditor(modeFixture, true);
        this.editorSettings.linderaMode = mode;
        editorSession(view)!.configure();
        await this.checkLinderaMode(cm, mode);
      }
    });
    const offline = (
      globalThis as typeof globalThis & {
        __lindvimeraOfflineProbe?: { active: boolean; attempts: string[] };
      }
    ).__lindvimeraOfflineProbe;
    if (offline)
      await this.check("offline-local-assets", async () => {
        await this.plugin.wordsReady;
        requireCheck(offline.active, "Renderer network guard is inactive.");
        requireCheck(
          this.plugin.wordSegmenter().id.startsWith("lindera-ipadic-6.0.0-"),
          "Offline startup fell back to BudouX.",
        );
        requireCheck(
          offline.attempts.every((url) => url === "https://lindvimera-offline.invalid/"),
          "Startup attempted a renderer HTTP request.",
        );
        let blocked = false;
        try {
          await fetch("https://lindvimera-offline.invalid/");
        } catch (error) {
          blocked = String(error).includes("Offline renderer probe");
        }
        requireCheck(blocked, "Renderer HTTP requests were not blocked.");
      });
    await this.check("budoux-markdown-surround", () => {
      const text = "今日は良い天気です。\n# First\n```md\n# fake\n```\n# Second";
      const { cm } = this.resetEditor(text);
      keys(cm, "w");
      requireCheck(
        cm.getCursor().ch === wordSpans(text.split("\n")[0])[1].from,
        "Japanese w did not use BudouX.",
      );
      keys(cm, "2]h");
      requireCheck(cm.getCursor().line === 5, "Heading motion counted a fenced pseudo-heading.");
      const second = this.resetEditor("word next last").cm;
      keys(second, "2ysw)");
      requireCheck(
        second.getValue() === "(word next )last",
        "Surround count did not apply to the motion range.",
      );
      const third = this.resetEditor("**word** next").cm;
      keys(third, "ds*");
      requireCheck(
        third.getValue() === "word next",
        "Delete-surround did not remove the complete Markdown delimiter run.",
      );
    });
  }

  async runPerformanceRegression(): Promise<void> {
    await this.check("large-note-performance", async () => {
      await this.plugin.wordsReady;
      const metrics = measureEditorPerformance(this.editorContainer, this.plugin.wordSegmenter());
      await this.plugin.app.vault.adapter.write(
        "Lindvimera performance.json",
        JSON.stringify(metrics, null, 2),
      );
    });
  }

  async runNativeRegression(): Promise<void> {
    await this.plugin.wordsReady;
    const target = this.plugin.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find(
        (view): view is MarkdownView =>
          view instanceof MarkdownView && view.file?.path === "Native table.md",
      );
    const owner = (target as (MarkdownView & { editMode?: unknown }) | undefined)?.editMode;
    const result = resolveNativeTable(owner);
    if (!result.supported) {
      await this.check("native-table-compatibility", () => {
        throw new Error(result.reason);
      });
      return;
    }
    const originalContext = result.context;
    const parent = originalContext.parent;
    const cm = getCM(parent);
    const baseline = parent.state.doc.toString();
    const original = originalContext.snapshot();
    const settle = () => new Promise<void>((resolve) => window.setTimeout(resolve, 120));
    const context = () => {
      const current = resolveNativeTable(owner);
      requireCheck(current.supported, current.supported ? "" : current.reason);
      return current.context;
    };
    const model = () => {
      const doc = parent.state.doc;
      const firstLine = doc.lineAt(Math.min(original.from, doc.length)).number;
      let end = doc.line(firstLine).to;
      for (let number = firstLine + 1; number <= doc.lines; number++) {
        const line = doc.line(number);
        if (!line.text.trim() || !line.text.includes("|")) break;
        end = line.to;
      }
      return parseMarkdownTable(doc.sliceString(original.from, end), original.from);
    };
    const focus = (row = 1, column = 0, offset = 0) => {
      context().focus({ row, column, offset });
      editorSession(parent)?.table.syncTarget();
    };
    const requireCell = (row: number, column: number, text: string) => {
      const actual = model();
      requireCheck(actual.rows.length === original.rows.length, "A cell edit changed table rows.");
      for (let r = 0; r < original.rows.length; r++) {
        requireCheck(
          actual.rows[r].length === original.rows[r].length,
          "A cell edit changed table columns.",
        );
        for (let c = 0; c < original.rows[r].length; c++) {
          const expected = r === row && c === column ? text : original.rows[r][c].map.text;
          requireCheck(
            actual.rows[r][c].map.text === expected,
            `Cell ${r},${c}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual.rows[r][c].map.text)}.`,
          );
        }
      }
    };
    const requirePosition = (row: number, column: number, offset?: number) => {
      const actual = context().position();
      requireCheck(
        actual.row === row &&
          actual.column === column &&
          (offset === undefined || actual.offset === offset),
        `Expected cell ${row},${column}${offset === undefined ? "" : ` at ${offset}`}, got ${JSON.stringify(actual)}.`,
      );
    };
    await this.check("native-table-compatibility", () => {
      requireCheck(
        cm?.state.vim &&
          editorSession(parent)?.table.nativeInputView() === originalContext.cellView,
        "The production Vim/table session is not attached to the parent editor.",
      );
      requireCheck(
        original.rows.length >= 3 &&
          original.rows[0].length >= 3 &&
          original.rows[0][0].map.text === "Name" &&
          original.rows[1][0].map.text === "日本語" &&
          original.rows[1][1].map.text === "a|b\n続き" &&
          original.rows[2][2].map.text === "text",
        "Restore the three-column fixture with Name, 日本語, a|b / 続き, and text cells.",
      );
    });
    if (!cm || !this.report.checks["native-table-compatibility"].passed) return;
    const initialEngine = cm;
    const resetFixture = async () => {
      cm.state.dialog?.querySelector("input")?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          bubbles: true,
          cancelable: true,
        }),
      );
      keys(cm, "<Esc>");
      editorSession(parent)?.flush();
      (owner as { destroyTableCell(): void }).destroyTableCell();
      const changed = parent.state.doc.toString() !== baseline;
      parent.dispatch({
        ...(changed ? { changes: { from: 0, to: parent.state.doc.length, insert: baseline } } : {}),
        selection: { anchor: original.rows[1][0].content.from },
        annotations: [Transaction.addToHistory.of(false), Transaction.userEvent.of("select")],
      });
      parent.focus();
      await settle();
      editorSession(parent)?.table.syncTarget();
      requireCheck(parent.state.doc.toString() === baseline, "Disposable fixture reset failed.");
      requireCheck(getCM(parent) === initialEngine, "Reset replaced the parent Vim session.");
    };
    const nativeCheck = async (name: string, callback: () => void | Promise<void>) => {
      await this.check(name, async () => {
        await resetFixture();
        try {
          await callback();
        } finally {
          await resetFixture();
        }
      });
    };
    const domKeys = async (sequence: string) => {
      for (const token of sequence.match(/<[^>]+>|./gu) ?? []) {
        const surface = resolveNativeTable(owner);
        const inputView = surface.supported ? (surface.context.cellView ?? parent) : parent;
        const event = keyboardEvent(token);
        inputView.contentDOM.dispatchEvent(event);
        if (!event.defaultPrevented && cm.state.vim?.insertMode && token.length === 1)
          insertBrowserText(inputView, token);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 12));
      }
    };
    await nativeCheck("native-cell-line-delete-undo-redo", async () => {
      focus(1, 1);
      keys(cm, "dd");
      await settle();
      const cleared = parent.state.doc.toString();
      requireCell(1, 1, "続き");
      keys(cm, "u");
      await settle();
      requireCheck(
        parent.state.doc.toString() === baseline,
        "One native Undo did not restore the deleted cell line.",
      );
      keys(cm, "<C-r>");
      await settle();
      requireCheck(
        parent.state.doc.toString() === cleared,
        "One native Redo did not reproduce the deleted cell line.",
      );
      keys(cm, "u");
      await settle();
    });
    await nativeCheck("native-cell-rectangle-delete", async () => {
      focus(1, 1);
      keys(cm, "<C-v>jld");
      await settle();
      requireCell(1, 1, "b\n");
      keys(cm, "u");
      await settle();
      requireCheck(
        parent.state.doc.toString() === baseline,
        "Rectangle deletion did not undo atomically.",
      );
    });
    await nativeCheck("native-cell-line-paste", async () => {
      focus(1, 1);
      keys(cm, "Vyp");
      await settle();
      requireCell(1, 1, "a|b\na|b\n続き");
      keys(cm, "u");
      await settle();
      requireCheck(
        parent.state.doc.toString() === baseline,
        "Cell line paste did not undo atomically.",
      );
    });
    await nativeCheck("native-cell-change-escape-undo", async () => {
      focus(1, 1);
      keys(cm, "cc");
      await settle();
      const cell = context().cellView;
      requireCheck(cell && cm.state.vim?.insertMode, "cc did not enter native cell input.");
      input(cell, "newj");
      requireVisibleCandidate(cell, "j");
      requireCell(1, 1, "new\n続き");
      input(cell, "j");
      await settle();
      const edited = parent.state.doc.toString();
      requireCheck(
        model().rows[1][1].map.text === "new\n続き" && !cm.state.vim?.insertMode,
        "cc/new/jj failed to preserve input and exit mode.",
      );
      keys(cm, "u");
      await settle();
      requireCheck(
        parent.state.doc.toString() === baseline,
        "One Undo did not restore native cc through jj.",
      );
      keys(cm, "<C-r>");
      await settle();
      requireCheck(
        parent.state.doc.toString() === edited,
        "One Redo did not restore native change.",
      );
      keys(cm, "u");
      await settle();
    });
    await nativeCheck("native-cell-insert-move-undo", async () => {
      focus(1, 1);
      await domKeys("ccabc<Left>");
      requireCheck(
        cm.state.vim?.insertMode && cm.getCursor().line === 0 && cm.getCursor().ch === 2,
        "Insert ArrowLeft did not move within the active cell.",
      );
      await domKeys("X<Esc>");
      await settle();
      requireCheck(!cm.state.vim?.insertMode, "Escape did not exit native cell Insert mode.");
      requireCell(1, 1, "abXc\n続き");
      await domKeys("u");
      await settle();
      requireCell(1, 1, "abc\n続き");
      await domKeys("u");
      await settle();
      requireCheck(
        parent.state.doc.toString() === baseline,
        "The second Undo did not restore the change before the Insert move.",
      );
      await domKeys("<C-r>");
      await settle();
      requireCell(1, 1, "abc\n続き");
      await domKeys("<C-r>");
      await settle();
      requireCell(1, 1, "abXc\n続き");
    });
    await nativeCheck("native-cell-motions-and-session", async () => {
      focus();
      await domKeys("$l");
      requirePosition(1, 0, 2);
      await domKeys("0h");
      requirePosition(1, 0, 0);
      await domKeys("$w");
      requirePosition(1, 0, 2);
      focus();
      await domKeys("w");
      const spans = wordSpans(
        original.rows[1][0].map.text,
        false,
        new WordBoundaryCache(
          512,
          262_144,
          this.plugin.settings.japanese,
          this.plugin.wordSegmenter(),
        ),
      );
      requirePosition(1, 0, spans.length > 1 ? spans[1].from : 2);
      await domKeys("jklh");
      requirePosition(1, 0);
      focus(1, 1);
      await domKeys("G");
      requirePosition(1, 1, 4);
      requireCheck(cm.getCursor().line === 1, "G did not use the cell's final line.");
      await domKeys("gg");
      requirePosition(1, 1, 0);
      requireCheck(cm.getCursor().line === 0, "gg did not use the cell's first line.");
      requireCheck(
        getCM(parent) === initialEngine && !!context().cellView,
        "Cell motions replaced the parent engine.",
      );
      requireCheck(
        parent.state.doc.toString() === baseline,
        "Normal keyboard motions changed table contents.",
      );
    });
    await nativeCheck("native-cell-cursor-and-search", async () => {
      const currentDialog = () => cm.state.dialog;
      focus(1, 1);
      await domKeys("<Esc>gg0");
      await settle();
      const cell = context().cellView;
      requireCheck(cell, "The active native cell editor is missing.");
      const promptClosed = (input: HTMLInputElement) =>
        !input.isConnected &&
        !currentDialog()?.querySelector("input") &&
        !cell.dom.querySelector(".cm-vim-panel input");
      const searchDiagnostic = () =>
        JSON.stringify({
          cursor: cm.getCursor(),
          nativeOffset: cell.state.selection.main.head,
          dialogText: currentDialog()?.textContent?.slice(0, 160),
          dialogHtml: currentDialog()?.outerHTML.slice(0, 500),
        });
      const layer = cell.dom.querySelector<HTMLElement>(".cm-vimCursorLayer");
      const cursor = layer?.querySelector<HTMLElement>(".cm-fat-cursor") ?? null;
      requireCheck(
        layer && cursor?.closest(".cm-vimCursorLayer") === layer,
        "The active cell has no Vim-owned block cursor.",
      );
      requireRenderedIn(cursor, cell.dom, "The native Vim block cursor");
      await domKeys("vl");
      await settle();
      requireRenderedIn(
        cell.dom.querySelector<HTMLElement>(".cm-selectionLayer .cm-selectionBackground"),
        cell.dom,
        "The native Visual selection",
      );
      await domKeys("<Esc>gg0/");
      await settle();
      const search = cell.dom.querySelector<HTMLInputElement>(".cm-vim-panel input");
      requireCheck(
        search && currentDialog()?.contains(search),
        "The Vim search prompt is not owned by the current cell.",
      );
      requireRenderedIn(search, cell.dom, "The native cell search input");
      search.value = "続き";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      search.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
      requirePosition(1, 1, 4);
      requireCheck(
        cm.getCursor().line === 1 && promptClosed(search),
        `The committed search must select cell line 1 and close its input: ${searchDiagnostic()}`,
      );
      await domKeys("n");
      requirePosition(1, 1, 4);
      await domKeys("/");
      await settle();
      const pending = cell.dom.querySelector<HTMLInputElement>(".cm-vim-panel input");
      requireCheck(
        pending && currentDialog()?.contains(pending),
        "The second cell search prompt is missing.",
      );
      pending.value = "cancelled";
      pending.dispatchEvent(new Event("input", { bubbles: true }));
      pending.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
      requireCheck(promptClosed(pending), `Esc left a pending search input: ${searchDiagnostic()}`);
      requirePosition(1, 1, 4);
      requireCheck(
        parent.state.doc.toString() === baseline,
        "Cell cursor/selection/search checks changed the parent note or table.",
      );
    });
    await nativeCheck("native-explicit-cell-navigation", async () => {
      focus();
      await domKeys("<Tab>");
      requirePosition(1, 1, 0);
      await domKeys("<S-Tab>");
      requirePosition(1, 0, 0);
      focus(0, 0);
      await domKeys("<S-Tab>");
      requirePosition(0, 0, 0);
      const row = original.rows.length - 1;
      const column = original.rows[row].length - 1;
      focus(row, column);
      await domKeys("<Tab>");
      requirePosition(row, column, 0);
      await domKeys("<Esc>");
      requirePosition(row, column, 0);
      requireCheck(getCM(parent) === initialEngine, "Cell navigation replaced the Vim engine.");
      requireCheck(parent.state.doc.toString() === baseline, "Cell navigation changed the table.");
    });
    await nativeCheck("native-insert-host-navigation", async () => {
      focus();
      await domKeys("i<Tab>");
      requirePosition(1, 1);
      requireCheck(cm.state.vim?.insertMode, "Native Insert Tab lost Insert mode.");
      await domKeys("<S-Tab>");
      requirePosition(1, 0);
      requireCheck(cm.state.vim?.insertMode, "Native Insert Shift-Tab lost Insert mode.");
      await domKeys("<Enter>");
      requirePosition(2, 0);
      requireCheck(cm.state.vim?.insertMode, "Native Insert Enter lost Insert mode.");
      requireCheck(
        parent.state.doc.toString() === baseline,
        "Insert navigation changed the existing table contents.",
      );
      const lastRow = original.rows.length - 1;
      focus(lastRow, original.rows[lastRow].length - 1);
      await domKeys("<Tab>");
      await settle();
      const expanded = model();
      requireCheck(
        expanded.rows.length === original.rows.length + 1,
        "Native Insert Tab at the final cell did not append exactly one row.",
      );
      requireCheck(
        expanded.rows.every((row) => row.length === original.rows[0].length),
        "Native Insert Tab changed the column count.",
      );
      for (let row = 0; row < original.rows.length; row++) {
        for (let column = 0; column < original.rows[row].length; column++)
          requireCheck(
            expanded.rows[row][column].map.text === original.rows[row][column].map.text,
            "Native row creation changed an existing cell.",
          );
      }
      requireCheck(
        expanded.rows.at(-1)!.every((cell) => cell.map.text === ""),
        "The row created by native Insert Tab is not empty.",
      );
      requirePosition(original.rows.length, 0);
      requireCheck(
        cm.state.vim?.insertMode && getCM(parent) === initialEngine,
        "Native row creation lost Insert mode or replaced the Vim engine.",
      );
      await domKeys("<Esc>u");
      await settle();
      requireCheck(
        parent.state.doc.toString() === baseline,
        "One parent Undo did not restore the table after native row creation.",
      );
    });
    await nativeCheck("native-cell-open-line", async () => {
      for (const [command, expected] of [
        ["o", "日本語\nnew"],
        ["O", "new\n日本語"],
      ]) {
        focus();
        await domKeys(`${command}new<Esc>`);
        await settle();
        requireCell(1, 0, expected);
        requireCheck(!cm.state.vim?.insertMode, "Esc did not leave native cell Insert mode.");
        requirePosition(1, 0);
        await domKeys("u");
        await settle();
        requireCheck(
          parent.state.doc.toString() === baseline,
          `${command} and inserted text did not undo as one cell edit.`,
        );
      }
    });
    await nativeCheck("native-keyboard-macro-and-escape", async () => {
      focus();
      await domKeys("qaAxyzjjq");
      requireCheck(
        model().rows[1][0].map.text === original.rows[1][0].map.text + "xyz" &&
          !cm.state.vim?.insertMode,
        "Native keyboard insertion did not exit through jj.",
      );
      const register = Vim.getRegisterController().getRegister("a");
      requireCheck(
        !register.keyBuffer.join("").includes("jj"),
        "Native-cell macro recorded escape characters.",
      );
      focus(2, 0);
      await domKeys("@a");
      requireCheck(
        model().rows[2][0].map.text === original.rows[2][0].map.text + "xyz" &&
          !cm.state.vim?.insertMode,
        "Native-cell macro failed after cell regeneration.",
      );
      requireCheck(getCM(parent) === initialEngine, "Macro replay replaced the parent Vim state.");
    });
    await nativeCheck("native-cell-dot-and-named-register", async () => {
      focus();
      const first = original.rows[1][0].map.text;
      const spans = wordSpans(
        first,
        false,
        new WordBoundaryCache(
          512,
          262_144,
          this.plugin.settings.japanese,
          this.plugin.wordSegmenter(),
        ),
      );
      const changed = `new${first.slice(spans[0].to)}`;
      await domKeys("ciwnew<Esc>");
      await settle();
      requireCell(1, 0, changed);
      const firstEdit = parent.state.doc.toString();
      const firstView = context().cellView;
      focus(2, 2);
      requireCheck(
        context().cellView !== firstView,
        "The dot replay did not exercise native cell recreation.",
      );
      await domKeys(".");
      await settle();
      requireCheck(
        model().rows[1][0].map.text === changed && model().rows[2][2].map.text === "new",
        "Dot did not replay the recorded change in the newly focused cell.",
      );
      await domKeys("u");
      await settle();
      requireCheck(
        parent.state.doc.toString() === firstEdit,
        "One parent Undo did not remove only the dot replay.",
      );
      await domKeys("u");
      await settle();
      requireCheck(
        parent.state.doc.toString() === baseline,
        "The initial change did not undo back to the fixture.",
      );
      focus(0, 0);
      await domKeys('"byiw');
      requireCheck(
        Vim.getRegisterController().getRegister("b").toString() === "Name",
        "The named register did not receive the source cell word.",
      );
      focus(1, 1);
      await domKeys('"bP');
      await settle();
      requireCell(1, 1, "Name" + original.rows[1][1].map.text);
      await domKeys("u");
      await settle();
      requireCheck(
        parent.state.doc.toString() === baseline,
        "Named-register paste did not undo as one parent edit.",
      );
      requireCheck(
        getCM(parent) === initialEngine,
        "Cross-cell dot or named-register paste replaced the Vim engine.",
      );
    });
    await nativeCheck("native-cell-character-paste-and-surround", async () => {
      focus();
      const first = original.rows[1][0].map.text;
      await domKeys("0v$y");
      focus(1, 1);
      await domKeys("P");
      requireCell(1, 1, first + original.rows[1][1].map.text);
      await domKeys("u");
      await settle();
      requireCheck(
        parent.state.doc.toString() === baseline,
        "Character paste did not undo in one parent event.",
      );
      focus();
      await domKeys("0v$gS)");
      await settle();
      requireCell(1, 0, `(${first})`);
      await domKeys("u");
      await settle();
      requireCheck(
        parent.state.doc.toString() === baseline,
        "Selected-cell Surround did not undo atomically.",
      );
    });
    await nativeCheck("native-table-entry-exit", async () => {
      focus();
      await domKeys("[t");
      requireCheck(
        !editorSession(parent)?.table.nativeInputView() &&
          parent.state.selection.main.head < original.from,
        "[t did not leave the table for the preceding text.",
      );
      requireCheck(parent.state.doc.toString() === baseline, "[t changed note content.");
      await resetFixture();
      focus();
      await domKeys("]t");
      requireCheck(
        !editorSession(parent)?.table.nativeInputView() &&
          parent.state.selection.main.head > original.to,
        "]t did not leave the table for the following text.",
      );
      requireCheck(parent.state.doc.toString() === baseline, "]t changed note content.");
      requireCheck(getCM(parent) === initialEngine, "Leaving the table replaced the Vim engine.");
    });
    await nativeCheck("native-cell-lindera-modes", async () => {
      await this.plugin.wordsReady;
      const saved = {
        japanese: this.plugin.settings.japanese,
        linderaMode: this.plugin.settings.linderaMode,
      };
      try {
        for (const mode of ["normal", "decompose"] as const) {
          await resetFixture();
          this.plugin.settings.japanese = true;
          this.plugin.settings.linderaMode = mode;
          await this.plugin.saveSettings();
          await settle();
          focus(1, 0);
          keys(cm, "cc");
          await settle();
          insertBrowserText(cm.getEditingView(), modeFixture);
          keys(cm, "<Esc>");
          await settle();
          requireCell(1, 0, modeFixture);
          await this.checkLinderaMode(cm, mode, settle);
          requireCell(1, 0, modeFixture);
          requireCheck(
            getCM(parent) === initialEngine,
            "Changing modes replaced the parent Vim engine.",
          );
        }
      } finally {
        Object.assign(this.plugin.settings, saved);
        await this.plugin.saveSettings();
      }
    });
    await this.check("native-fixture-restored", () => {
      requireCheck(
        parent.state.doc.toString() === baseline,
        "Native fixture was not restored; reset the disposable fixture before retrying.",
      );
    });
  }

  async runHostRegression(): Promise<void> {
    await this.plugin.wordsReady;
    await runHostRegression(this.plugin, (name, callback) => this.check(name, callback));
    await this.runNoteIntegrationRegression();
    await this.runPerformanceRegression();
  }

  private async runNoteIntegrationRegression(): Promise<void> {
    const { app } = this.plugin;
    const sourcePath = "Lindvimera link source.md";
    const targetPath = "Lindvimera link target.md";
    const sourceText = "No saved links.\n";
    const targetText =
      "# Link target\n\nIntro.\n\n## Target heading\n\nHeading body.\n\nBlock body. ^probe-block\n";
    const fixtures: { file: TFile; restore: string }[] = [];
    const fixture = async (path: string, text: string) => {
      const existing = app.vault.getAbstractFileByPath(path);
      const file = existing instanceof TFile ? existing : await app.vault.create(path, text);
      fixtures.push({
        file,
        restore: existing instanceof TFile ? await app.vault.read(file) : text,
      });
      if (existing instanceof TFile) await app.vault.modify(file, text);
      return file;
    };
    const leaf = app.workspace.getLeaf("tab");
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = Date.now() + 3000;
      while (!condition() && Date.now() < deadline)
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      requireCheck(condition(), message);
    };
    try {
      const sourceFile = await fixture(sourcePath, sourceText);
      const targetFile = await fixture(targetPath, targetText);
      const openSource = async (source = true) => {
        await app.vault.modify(sourceFile, sourceText);
        await leaf.openFile(sourceFile, { state: { mode: "source", source } });
        app.workspace.setActiveLeaf(leaf, { focus: true });
        await waitFor(
          () =>
            leaf.view instanceof MarkdownView &&
            (leaf.view as MarkdownView & { editMode: { sourceMode: boolean } }).editMode
              .sourceMode === source &&
            !!editorSession(
              (leaf.view as MarkdownView & { editMode: { cm: EditorView } }).editMode.cm,
            ),
          "The link fixture did not receive the production editor session.",
        );
        requireCheck(
          leaf.view instanceof MarkdownView,
          "The source fixture is not a Markdown view.",
        );
        const markdown = leaf.view;
        const parent = (markdown as MarkdownView & { editMode: { cm: EditorView } }).editMode.cm;
        const cm = getCM(parent)!;
        // Opening the same file can retain its unsaved buffer while vault.modify
        // is still propagating. Reset the disposable editor as well as the file,
        // before any measured input, so earlier mode tests cannot leak text here.
        keys(cm, "<Esc>");
        parent.dispatch({
          changes:
            parent.state.doc.toString() === sourceText
              ? undefined
              : { from: 0, to: parent.state.doc.length, insert: sourceText },
          selection: { anchor: 0 },
          annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
        });
        requireCheck(
          parent.state.doc.toString() === sourceText && !cm.state.vim?.insertMode,
          "The source fixture did not reset to its baseline in Normal mode.",
        );
        parent.focus();
        return { markdown, parent, cm };
      };
      await this.check("host-body-insert-move-undo", async () => {
        for (const source of [true, false]) {
          const { parent, cm } = await openSource(source);
          parent.dispatch({
            changes: { from: 0, to: parent.state.doc.length, insert: "" },
            selection: { anchor: 0 },
            annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
          });
          keys(cm, "i");
          insertBrowserText(parent, "abc");
          parent.contentDOM.dispatchEvent(keyboardEvent("<Left>"));
          requireCheck(
            cm.state.vim?.insertMode && parent.state.selection.main.head === 2,
            `Insert ArrowLeft did not move in ${source ? "Source" : "Live Preview"}.`,
          );
          insertBrowserText(parent, "X");
          keys(cm, "<Esc>");
          requireCheck(cm.getValue() === "abXc", "Insert after ArrowLeft changed the wrong text.");
          keys(cm, "u");
          requireCheck(cm.getValue() === "abc", "The first Undo crossed the Insert cursor move.");
          keys(cm, "u");
          requireCheck(cm.getValue() === "", "The second Undo did not remove the first insertion.");
          keys(cm, "<C-r>");
          requireCheck(cm.getValue() === "abc", "The first Redo restored the wrong insertion.");
          keys(cm, "<C-r>");
          requireCheck(cm.getValue() === "abXc", "The second Redo did not restore the later edit.");
        }
      });
      await this.check("host-lindera-modes-and-switching", async () => {
        await this.plugin.wordsReady;
        const saved = {
          japanese: this.plugin.settings.japanese,
          linderaMode: this.plugin.settings.linderaMode,
        };
        try {
          for (const source of [true, false]) {
            const { parent, cm } = await openSource(source);
            const replace = (text: string) => {
              keys(cm, "<Esc>");
              parent.dispatch({
                changes: { from: 0, to: parent.state.doc.length, insert: text },
                selection: { anchor: 0 },
                annotations: [Transaction.userEvent.of("set"), Transaction.addToHistory.of(false)],
              });
            };
            for (const mode of ["normal", "decompose"] as const) {
              this.plugin.settings.japanese = true;
              this.plugin.settings.linderaMode = mode;
              await this.plugin.saveSettings();
              replace(modeFixture);
              await this.checkLinderaMode(cm, mode);
            }
            this.plugin.settings.linderaMode = "normal";
            await this.plugin.saveSettings();
            replace(modeFixture);
            keys(cm, "A");
            insertBrowserText(parent, " tail");
            keys(cm, '<Esc>0"ayiwviw');
            const selection = parent.state.selection;
            const vimState = cm.state.vim;
            const provider = cm.state.wordBoundaryProvider;
            const register = Vim.getRegisterController().getRegister("a").toString();
            const depth = undoDepth(parent.state);
            const before = cm.getValue();
            requireCheck(cm.state.vim?.visualMode, "The mode-switch fixture is not Visual.");
            this.plugin.settings.linderaMode = "decompose";
            await this.plugin.saveSettings();
            await waitFor(
              () => cm.state.wordBoundaryProvider !== provider,
              "The live mode change did not replace the word provider.",
            );
            requireCheck(
              getCM(parent) === cm && cm.state.vim === vimState && cm.state.vim?.visualMode,
              "A mode change replaced the Vim session or left Visual mode.",
            );
            requireCheck(
              parent.state.selection.eq(selection) && cm.getValue() === before,
              "A mode change modified the active selection or document.",
            );
            requireCheck(
              Vim.getRegisterController().getRegister("a").toString() === register &&
                undoDepth(parent.state) === depth,
              "A mode change modified registers or history.",
            );
            keys(cm, "<Esc>u");
            requireCheck(
              cm.getValue() === modeFixture,
              "Undo changed after replacing the provider.",
            );
            keys(cm, "<C-r>");
            requireCheck(cm.getValue() === before, "Redo changed after replacing the provider.");

            this.plugin.settings.japanese = false;
            await this.plugin.saveSettings();
            const persisted = (await this.plugin.loadData()) as Partial<LindvimeraSettings>;
            requireCheck(
              persisted.japanese === false && persisted.linderaMode === "decompose",
              "Disabling Japanese segmentation lost the saved split mode.",
            );
            const unsegmented = "今日は良い天気です。";
            replace(unsegmented);
            keys(cm, "w");
            requireCheck(
              cm.getCursor().ch === unsegmented.length - 1 && !!cm.state.wordBoundaryProvider,
              "Japanese-off did not retain legacy word boundaries and the corrected provider.",
            );
            this.plugin.settings.japanese = true;
            await this.plugin.saveSettings();
            requireCheck(
              this.plugin.settings.linderaMode === "decompose",
              "Re-enabling Japanese segmentation reset its mode.",
            );
            replace(modeFixture);
            await this.checkLinderaMode(cm, "decompose");
          }
        } finally {
          Object.assign(this.plugin.settings, saved);
          await this.plugin.saveSettings();
        }
      });
      await this.check("host-hotkey-precedence", async () => {
        const { markdown, parent, cm } = await openSource();
        requireCheck(markdown.scope, "The Markdown view has no host key scope.");
        let findCalls = 0;
        let copyCalls = 0;
        let pasteCalls = 0;
        const handlers = [
          markdown.scope.register(["Ctrl"], "f", () => {
            findCalls++;
            return false;
          }),
          app.scope.register(["Ctrl"], "c", () => {
            copyCalls++;
            return false;
          }),
          app.scope.register(["Ctrl"], "v", () => {
            pasteCalls++;
            return false;
          }),
        ];
        const dispatch = (token: string) => parent.contentDOM.dispatchEvent(keyboardEvent(token));
        try {
          keys(cm, "<Esc>gg0");
          const before = parent.state.doc.toString();
          requireCheck(
            before === sourceText && !cm.state.vim?.insertMode && !cm.state.vim?.visualMode,
            `Hotkey fixture was not ready before Ctrl+F: ${JSON.stringify({
              text: before,
              insertMode: cm.state.vim?.insertMode,
              visualMode: cm.state.vim?.visualMode,
            })}`,
          );
          dispatch("<C-f>");
          requireCheck(
            findCalls === 0,
            "Normal Ctrl+F reached the host search callback instead of Vim page movement.",
          );
          dispatch("i");
          dispatch("<C-f>");
          requireCheck(
            Number(findCalls) === 1 && cm.state.vim?.insertMode,
            "Insert Ctrl+F did not delegate once to the host while preserving Insert mode.",
          );
          dispatch("<Esc>");
          keys(cm, "d");
          dispatch("<C-c>");
          requireCheck(
            !cm.state.vim?.inputState.operator && !cm.state.vim?.visualMode,
            "Ctrl+C did not cancel the pending Normal-mode command.",
          );
          keys(cm, "v");
          dispatch("<C-c>");
          requireCheck(!cm.state.vim?.visualMode, "Ctrl+C did not leave Visual mode.");
          dispatch("<C-v>");
          requireCheck(
            cm.state.vim?.visualMode && cm.state.vim?.visualBlock,
            "Ctrl+V did not enter Vim block selection.",
          );
          requireCheck(
            copyCalls === 0 && pasteCalls === 0,
            "Normal/Visual Ctrl+C or Ctrl+V reached the registered host callback.",
          );
          requireCheck(
            parent.state.doc.toString() === before,
            `Hotkey checks changed the note: ${JSON.stringify({
              before,
              after: parent.state.doc.toString(),
              cursor: cm.getCursor(),
              insertMode: cm.state.vim?.insertMode,
              visualMode: cm.state.vim?.visualMode,
            })}`,
          );
        } finally {
          keys(cm, "<Esc>");
          for (const handler of handlers) handler.scope.unregister(handler);
        }
      });
      await this.check("host-gf-unsaved-links", async () => {
        await waitFor(() => {
          const cache = app.metadataCache.getFileCache(targetFile);
          return (
            !!cache?.headings?.some((heading) => heading.heading === "Target heading") &&
            !!cache.blocks?.["probe-block"]
          );
        }, "The target heading and block metadata are unavailable.");
        for (const [link, line] of [
          ["[[Lindvimera link target#Target heading|alias]]", 4],
          ["[block](Lindvimera%20link%20target.md#^probe-block)", 8],
        ] as const) {
          const { markdown, parent, cm } = await openSource();
          await waitFor(
            () => !app.metadataCache.getFileCache(sourceFile)?.links?.length,
            "The source fixture still has cached links before the unsaved edit.",
          );
          requireCheck(
            (await app.vault.read(sourceFile)) === sourceText,
            "The source fixture already contains the test link on disk.",
          );
          const leavesBefore = app.workspace.getLeavesOfType("markdown").length;
          markdown.editor.setValue(link);
          markdown.editor.setCursor({ line: 0, ch: 3 });
          requireCheck(
            !app.metadataCache.getFileCache(sourceFile)?.links?.length,
            "The edited link was already in the metadata cache before gf.",
          );
          requireCheck(!cm.state.vim?.insertMode, "The gf fixture did not start in Normal mode.");
          parent.contentDOM.dispatchEvent(keyboardEvent("g"));
          parent.contentDOM.dispatchEvent(keyboardEvent("f"));
          await waitFor(
            () => leaf.view instanceof MarkdownView && leaf.view.file?.path === targetPath,
            "gf did not open the current unsaved link in the same leaf.",
          );
          requireCheck(leaf.view instanceof MarkdownView, "gf did not open a Markdown target.");
          await waitFor(() => {
            const view = leaf.view as MarkdownView;
            return view.editor.getCursor().line === line || view.getEphemeralState().line === line;
          }, `gf did not resolve the target heading/block at line ${line}.`);
          requireCheck(
            app.workspace.getLeavesOfType("markdown").length === leavesBefore,
            "gf created another Markdown leaf.",
          );
        }
      });
    } finally {
      leaf.detach();
      for (const { file, restore } of fixtures) await app.vault.modify(file, restore);
      await app.workspace.revealLeaf(this.leaf);
    }
  }

  private async save(): Promise<void> {
    const json = JSON.stringify(this.report, null, 2);
    if (this.status) this.status.textContent = json;
    await this.plugin.app.vault.adapter.write(ACCEPTANCE_REPORT_PATH, json);
  }

  async onClose(): Promise<void> {
    this.editor?.destroy();
    this.editor = undefined;
  }
}
