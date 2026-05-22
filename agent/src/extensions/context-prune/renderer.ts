import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { normalizeSummaryToolCallRefs } from "./summary-refs.js";
import { isRecord } from "../../utils/unknown-data.js";

export function registerSummaryRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("context-prune-summary", (message, { expanded }, theme) => {
    const refs = normalizeSummaryToolCallRefs(message.details);
    const turnIndex = readTurnIndex(message.details);
    const header = theme.fg(
      "accent",
      `[pruner] Turn ${turnIndex} summary (${refs.length} tool${refs.length === 1 ? "" : "s"})`,
    );
    const content = typeof message.content === "string" ? message.content : "";
    return new Text(expanded ? `${header}\n${content}` : header, 0, 0);
  });
}

function readTurnIndex(details: unknown): string | number {
  if (!isRecord(details)) return "?";
  return typeof details.turnIndex === "number" ? details.turnIndex : "?";
}
