import type { RunRecord } from "./store/types.js";

export const HERDR_BLOCKED_REASON = "Pi session needs operator input in Herdr";

export function isHerdrAttentionBlocked(run: RunRecord): boolean {
  return run.status === "blocked" && run.lastError === HERDR_BLOCKED_REASON;
}

export function activeStatusForRun(run: RunRecord): "in_progress" | "in_review" {
  return run.prNumber === undefined ? "in_progress" : "in_review";
}
