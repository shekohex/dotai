import type { RuntimeSubagent } from "./types.js";

export function buildInterruptedLiteState(
  state: RuntimeSubagent,
  updatedAt: number,
): RuntimeSubagent {
  return {
    ...state,
    event: "updated",
    status: "idle",
    activity: {
      sessionId: state.sessionId,
      kind: "idle",
      label: "interrupted",
      startedAt: updatedAt,
      updatedAt,
      done: true,
    },
    updatedAt,
  };
}
