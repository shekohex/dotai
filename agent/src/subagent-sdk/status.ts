import type { RuntimeSubagent, SubagentStatusDetails, SubagentTerminalStatus } from "./types.js";

export function isTerminalSubagentStatus(
  status: RuntimeSubagent["status"],
): status is SubagentTerminalStatus {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function toSubagentStatusDetails(
  state: Pick<RuntimeSubagent, "sessionId" | "name" | "status" | "summary">,
): SubagentStatusDetails | undefined {
  if (!isTerminalSubagentStatus(state.status)) return undefined;
  return {
    sessionId: state.sessionId,
    name: state.name,
    status: state.status,
    ...(state.summary === undefined ? {} : { summary: state.summary }),
  };
}
