import type { AgentToolUpdateCallback, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { cloneRuntimeSubagent } from "./types.js";
import type { MessageSubagentParams, RuntimeSubagent } from "./types.js";
import type { SubagentHandle, SubagentSDK, SubagentSDKEvent } from "./sdk-types.js";

const noop = () => {};

function isTerminalStatus(status: RuntimeSubagent["status"]): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

export class SDKSubagentHandle implements SubagentHandle {
  constructor(
    private readonly sdk: SubagentSDK,
    public readonly sessionId: string,
  ) {}

  getState(): RuntimeSubagent {
    const state = this.sdk.list().find((candidate) => candidate.sessionId === this.sessionId);
    if (!state) {
      throw new Error(`Unknown subagent sessionId: ${this.sessionId}`);
    }
    return cloneRuntimeSubagent(state);
  }

  sendMessage(
    params: Omit<MessageSubagentParams, "sessionId">,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
  ) {
    return this.sdk
      .message({ ...params, sessionId: this.sessionId }, ctx, onUpdate)
      .then((result) => result.result);
  }

  cancel() {
    return this.sdk.cancel({ sessionId: this.sessionId });
  }

  waitForCompletion(options: { signal?: AbortSignal } = {}): Promise<RuntimeSubagent> {
    const currentState = this.getState();
    if (isTerminalStatus(currentState.status)) {
      return Promise.resolve(currentState);
    }
    return new Promise<RuntimeSubagent>((resolve, reject) => {
      let cleanup = noop;
      const dispose = () => {
        cleanup();
        options.signal?.removeEventListener("abort", abortHandler);
      };
      const abortHandler = () => {
        dispose();
        reject(new Error("Cancelled"));
      };
      cleanup = this.onEvent(({ state }) => {
        if (!isTerminalStatus(state.status)) {
          return;
        }
        dispose();
        resolve(state);
      });
      const updatedState = this.getState();
      if (isTerminalStatus(updatedState.status)) {
        dispose();
        resolve(updatedState);
        return;
      }
      if (options.signal?.aborted === true) {
        abortHandler();
        return;
      }
      options.signal?.addEventListener("abort", abortHandler, { once: true });
    });
  }

  captureOutput(lines?: number) {
    return this.sdk.captureOutput({ sessionId: this.sessionId, lines });
  }

  onEvent(listener: (event: SubagentSDKEvent) => void): () => void {
    return this.sdk.onEvent((event) => {
      if (event.state.sessionId !== this.sessionId) {
        return;
      }
      listener(event);
    });
  }
}
