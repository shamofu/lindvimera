import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { EditorState, StateField, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App } from "obsidian";
import { getCM } from "@replit/codemirror-vim";
import { createBackend } from "../../src/engines/embedded";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { budouxSegmenter } from "../../src/word";

const field = StateField.define<object>({ create: () => ({}), update: (value) => value });
vi.mock("obsidian", () => ({
  get editorInfoField() {
    return field;
  },
  MarkdownView: class {},
  Scope: class {},
}));
const views: EditorView[] = [];
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

it("suspends immediately on a host conflict and disposes its installed editor", async () => {
  let active = true;
  let extension: Extension = [];
  const settings = { ...DEFAULT_SETTINGS, japanese: false };
  const backend = createBackend({
    app: {} as App,
    settings: () => settings,
    wordSegmenter: () => budouxSegmenter,
    isActive: () => active,
    reportMode: () => {},
    reportError: () => {},
    registerEditorExtension: (value) => {
      extension = value;
    },
  });
  const owner: { cm?: EditorView } = {};
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: "abc",
      extensions: [field.init(() => ({ editMode: owner })), extension],
    }),
  });
  owner.cm = view;
  views.push(view);
  await Promise.resolve();
  view.focus();
  expect(getCM(view)).not.toBeNull();
  active = false;
  const event = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(view.state.doc.toString()).toBe("abc");
  backend.refresh();
  await Promise.resolve();
  expect(getCM(view)).toBeNull();
  active = true;
  backend.refresh();
  await Promise.resolve();
  expect(getCM(view)).not.toBeNull();
  backend.dispose();
  expect(getCM(view)).toBeNull();
});
