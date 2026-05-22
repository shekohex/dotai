import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatCharProgress } from "./stats.js";
import { PROGRESS_WIDGET_ID, type CapturedBatch } from "./types.js";

type RowStatus = "pending" | "running" | "done" | "skipped";

interface WidgetRow {
  label: string;
  toolCallCount: number;
  rawChars: number;
  status: RowStatus;
  receivedChars: number;
}

export interface PrunerWidget {
  updateRow(index: number, status: RowStatus, chars?: number): void;
  clearWidget(): void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 120;

export function startPrunerWidget(
  ctx: ExtensionCommandContext,
  batches: CapturedBatch[],
): PrunerWidget {
  const rows = createRows(batches);
  let requestRender: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const sync = () => {
    if (rows.some((row) => row.status === "running") && timer === undefined) {
      timer = setInterval(() => {
        requestRender?.();
      }, SPINNER_INTERVAL_MS);
      timer.unref?.();
    }
    if (!rows.some((row) => row.status === "running")) stopTimer();
    requestRender?.();
  };
  ctx.ui.setWidget(
    PROGRESS_WIDGET_ID,
    (tui) => {
      requestRender = () => {
        tui.requestRender();
      };
      return { invalidate() {}, render: () => rows.map((row) => renderRow(row)) };
    },
    { placement: "aboveEditor" },
  );
  return {
    updateRow(index, status, chars) {
      const row = rows[index];
      if (row === undefined) return;
      row.status = status;
      row.receivedChars = chars ?? row.receivedChars;
      sync();
    },
    clearWidget() {
      stopTimer();
      requestRender = undefined;
      ctx.ui.setWidget(PROGRESS_WIDGET_ID, undefined);
    },
  };
}

function createRows(batches: CapturedBatch[]): WidgetRow[] {
  return batches.map((batch, index) => ({
    label: `Batch ${index + 1}/${batches.length}`,
    toolCallCount: batch.toolCalls.length,
    rawChars: batch.toolCalls.reduce((sum, toolCall) => sum + toolCall.resultText.length, 0),
    status: "pending",
    receivedChars: 0,
  }));
}

function renderRow(row: WidgetRow): string {
  const count = `${row.toolCallCount} tool call${row.toolCallCount === 1 ? "" : "s"}`;
  if (row.status === "running")
    return `${spinnerFrame()} ${row.label} · ${count}${charSuffix(row)}`;
  if (row.status === "done")
    return `✓ ${row.label} · ${count} · ${formatCharProgress(row.receivedChars, row.rawChars)}`;
  if (row.status === "skipped") return `⚠ ${row.label} · ${count} · skipped`;
  return `○ ${row.label} · ${count} · pending`;
}

function charSuffix(row: WidgetRow): string {
  return row.receivedChars > 0 ? ` · ${formatCharProgress(row.receivedChars, row.rawChars)}` : "";
}

function spinnerFrame(): string {
  return (
    SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length] ?? "⠋"
  );
}
