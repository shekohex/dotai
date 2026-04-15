import type { RuntimeSubagent } from "./types.js";

export type SubagentRuntimeEvent = {
  type: RuntimeSubagent["event"];
  state: RuntimeSubagent;
};

function getStateSignature(state: RuntimeSubagent): string {
  return JSON.stringify({
    event: state.event,
    status: state.status,
    paneId: state.paneId,
    completedAt: state.completedAt,
    autoExitDeadlineAt: state.autoExitDeadlineAt,
    autoExitTimeoutActive: state.autoExitTimeoutActive,
    summary: state.summary,
    structured: state.structured,
    structuredError: state.structuredError,
    exitCode: state.exitCode,
  });
}

export class SubagentRuntimeEventBus {
  private listeners = new Set<(event: SubagentRuntimeEvent) => void>();
  private stateSignatures = new Map<string, string>();

  emitChangedStates(states: RuntimeSubagent[]): void {
    for (const state of states) {
      const signature = getStateSignature(state);
      if (this.stateSignatures.get(state.sessionId) === signature) {
        continue;
      }

      this.stateSignatures.set(state.sessionId, signature);
      const event = { type: state.event, state } satisfies SubagentRuntimeEvent;
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  subscribe(listener: (event: SubagentRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
