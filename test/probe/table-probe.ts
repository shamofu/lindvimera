import { historyField, redoDepth, undoDepth } from "@codemirror/commands";
import { MarkdownView, Notice, Plugin, apiVersion } from "obsidian";
import { getCM, Vim, editorSession, resolveNativeTable, parseMarkdownTable } from "./runtime";
import type { NativeTableContext } from "../../src/table/native-adapter";
import type { CellPosition } from "../../src/table/selection";
import type { MarkdownTable } from "../../src/table/source";

export const TABLE_PROBE_REPORT_PATH = "Lindvimera table probe.json";
type ProbeStatus = "passed" | "failed" | "unverified";
export interface TableProbeCheck {
  status: ProbeStatus;
  detail: string;
}
export interface TableProbeReport {
  schemaVersion: 2;
  probe: "native-cell";
  timestamp: string;
  obsidianVersion: string;
  pluginVersion: string;
  status: ProbeStatus;
  checks: Record<string, TableProbeCheck>;
  note?: string;
  cell?: CellPosition;
  snapshot?: MarkdownTable;
  before?: string;
  cleared?: string;
  restored?: boolean;
  error?: string;
}
function assertCheck(
  report: TableProbeReport,
  name: string,
  passed: boolean,
  detail: string,
): void {
  report.checks[name] = { status: passed ? "passed" : "failed", detail };
  if (!passed) throw new Error(detail);
}
async function settle(context: NativeTableContext): Promise<void> {
  await new Promise<void>((resolve) => {
    const window = context.parent.contentDOM.ownerDocument.defaultView;
    if (window) window.setTimeout(resolve, 100);
    else globalThis.setTimeout(resolve, 100);
  });
}

/** Run the production cell editor and parent history only inside the disposable probe Vault. */
export async function runNativeTableProbe(
  plugin: Plugin,
  view?: MarkdownView,
): Promise<TableProbeReport> {
  const report: TableProbeReport = {
    schemaVersion: 2,
    probe: "native-cell",
    timestamp: new Date().toISOString(),
    obsidianVersion: apiVersion,
    pluginVersion: plugin.manifest.version,
    status: "unverified",
    checks: Object.fromEntries(
      ["compatibility", "clear", "structure", "single-undo", "redo", "restoration"].map((name) => [
        name,
        { status: "unverified", detail: "Not run." },
      ]),
    ),
  };
  try {
    const target = view ?? plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!target) {
      report.error = "Open Native table.md in Live Preview and focus a cell first.";
      return report;
    }
    report.note = target.file?.path;
    const owner: unknown = (target as MarkdownView & { editMode?: unknown }).editMode;
    const resolve = () => {
      const result = resolveNativeTable(owner);
      if (!result.supported) throw new Error(result.reason);
      return result.context;
    };
    let context = resolve();
    const parent = context.parent;
    const runtime = editorSession(parent);
    const cm = getCM(parent);
    if (!runtime || !cm)
      throw new Error("The production Lindvimera editor runtime is not attached.");
    runtime.finishInsert();
    context = resolve();
    const snapshot = context.snapshot();
    const current = context.currentCell;
    if (!current) throw new Error("Focus a populated native cell first.");
    const cell = snapshot.rows[current.row]![current.column]!;
    if (!cell.map.text) {
      report.error = "The probe needs a populated current cell.";
      return report;
    }
    report.snapshot = snapshot;
    report.cell = { ...current, offset: 0 };
    report.before = parent.state.doc.toString();
    assertCheck(
      report,
      "compatibility",
      true,
      "Current cell, decoded text and parent source offsets agree.",
    );
    assertCheck(
      report,
      "parent-history",
      parent.state.field(historyField, false) !== undefined,
      "The real parent editor must provide CodeMirror history.",
    );
    const keys = (value: string) => {
      runtime.table.syncTarget();
      for (const key of value.match(/<[^>]+>|./gu) ?? [])
        cm.operation(() => Vim.handleKey(cm, key, "user"));
    };
    const depthBefore = undoDepth(parent.state);
    keys("ggdG");
    await settle(context);
    context = resolve();
    const cleared = context.snapshot();
    report.cleared = parent.state.doc.toString();
    const expected =
      report.before.slice(0, cell.content.from) + report.before.slice(cell.content.to);
    assertCheck(
      report,
      "clear",
      report.cleared === expected && cleared.rows[current.row]![current.column]!.map.text === "",
      "The ordinary Vim operator clears only the current cell through native parent synchronization.",
    );
    assertCheck(
      report,
      "structure",
      cleared.rows.length === snapshot.rows.length &&
        cleared.rows.every(
          (row, rowIndex) =>
            row.length === snapshot.rows[rowIndex]!.length &&
            row.every(
              (other, column) =>
                (rowIndex === current.row && column === current.column) ||
                other.map.text === snapshot.rows[rowIndex]![column]!.map.text,
            ),
        ) &&
        cleared.source.slice(
          cleared.separator.from - cleared.from,
          cleared.separator.to - cleared.from,
        ) ===
          snapshot.source.slice(
            snapshot.separator.from - snapshot.from,
            snapshot.separator.to - snapshot.from,
          ),
      "Every other cell, the separator, and the row/column counts are preserved.",
    );
    assertCheck(
      report,
      "single-history-event",
      undoDepth(parent.state) === depthBefore + 1,
      "The cell edit creates exactly one parent history event.",
    );
    keys("u");
    await settle(context);
    assertCheck(
      report,
      "single-undo",
      parent.state.doc.toString() === report.before &&
        undoDepth(parent.state) === depthBefore &&
        redoDepth(parent.state) > 0,
      "One parent Undo restores the complete original document.",
    );
    keys("<C-r>");
    await settle(context);
    assertCheck(
      report,
      "redo",
      parent.state.doc.toString() === report.cleared,
      "One parent Redo reproduces the current-cell edit.",
    );
    keys("u");
    await settle(context);
    report.restored = parent.state.doc.toString() === report.before;
    assertCheck(
      report,
      "restoration",
      report.restored,
      "The fixture is restored through parent Undo.",
    );
    // Reacquire the host's table after Undo/Redo, which may have recreated native objects.
    const restoredTable = parseMarkdownTable(
      parent.state.doc.sliceString(snapshot.from, snapshot.to),
      snapshot.from,
    );
    assertCheck(
      report,
      "restored-table",
      restoredTable.rows.length === snapshot.rows.length,
      "The restored Markdown table remains parseable.",
    );
    report.status = "passed";
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    return report;
  } finally {
    await plugin.app.vault.adapter.write(TABLE_PROBE_REPORT_PATH, JSON.stringify(report, null, 2));
    new Notice(`Lindvimera table probe: ${report.status}. ${TABLE_PROBE_REPORT_PATH}`);
  }
}

export function registerNativeTableProbe(plugin: Plugin): {
  reportPath: string;
  run: (view?: MarkdownView) => Promise<TableProbeReport>;
} {
  let running = false;
  const run = async (view?: MarkdownView) => {
    if (running) throw new Error("The native table probe is already running.");
    running = true;
    try {
      return await runNativeTableProbe(plugin, view);
    } finally {
      running = false;
    }
  };
  plugin.addCommand({
    id: "probe-native-table",
    name: "Probe native cell editing, Undo, and Redo (test vault)",
    callback: () => {
      void run().catch((error: unknown) => new Notice(String(error)));
    },
  });
  return { reportPath: TABLE_PROBE_REPORT_PATH, run };
}
