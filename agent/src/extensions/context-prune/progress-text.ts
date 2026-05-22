import type { CapturedBatch } from "./types.js";
import { formatCharProgress } from "./stats.js";

export type PruneProgressPhase = "running" | "done" | "skipped";

export function pruneProgressText(
  batch: CapturedBatch,
  index: number,
  total: number,
  receivedChars: number,
  phase: PruneProgressPhase = "running",
): string {
  const rawChars = batch.toolCalls.reduce((sum, tc) => sum + tc.resultText.length, 0);
  const toolCount = batch.toolCalls.length;
  const batchPrefix = total > 1 ? `batch ${index + 1}/${total} · ` : "";
  let phaseLabel = "Context prune skipped…";
  if (phase === "running") {
    phaseLabel = "Context prune running…";
  } else if (phase === "done") {
    phaseLabel = "Context prune done…";
  }

  return `${phaseLabel} ${batchPrefix}${formatCharProgress(receivedChars, rawChars)} · ${toolCount} tool call${toolCount === 1 ? "" : "s"}`;
}
