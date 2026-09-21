import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completionUsageReport } from "./format.js";
import { lastAssistantMessageText } from "./messages.js";
import type { ThreadGoal } from "./types.js";

/**
 * Build the user-visible goal completion notification body.
 *
 * @param {ThreadGoal} goal The goal that just completed.
 * @param {ExtensionContext} ctx Extension context for the last assistant output.
 * @returns {string} Final assistant text plus an optional usage report.
 */
export default function goalCompletionNotificationMessage(
  goal: ThreadGoal,
  ctx: ExtensionContext,
): string {
  const parts = [lastAssistantMessageText(ctx) ?? "Goal complete"];
  const usageReport = completionUsageReport(goal);
  if (usageReport !== null) {
    parts.push(usageReport);
  }
  return parts.join("\n\n");
}
