import type { RuntimeSubagent } from "./types.js";

export function isTerminalSubagentStatus(status: RuntimeSubagent["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
