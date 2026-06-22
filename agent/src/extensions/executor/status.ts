import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../../utils/error-message.js";
import type { ExecutorEndpoint } from "./connection.js";
import { resolveExecutorEndpoint } from "./connection.js";

export type ExecutorRuntimeState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | {
      kind: "ready";
      label: string;
      mcpUrl: string;
      webUrl: string;
    }
  | { kind: "error"; message: string };

export type ExecutorUpdatedEvent = {
  cwd: string;
  state: ExecutorRuntimeState;
};

export const EXECUTOR_UPDATED_EVENT = "executor:updated";

const statesByCwd = new Map<string, ExecutorRuntimeState>();

export function getExecutorState(cwd: string): ExecutorRuntimeState {
  return statesByCwd.get(cwd) ?? { kind: "idle" };
}

function emitExecutorState(pi: ExtensionAPI, cwd: string, state: ExecutorRuntimeState): void {
  pi.events.emit(EXECUTOR_UPDATED_EVENT, {
    cwd,
    state,
  } satisfies ExecutorUpdatedEvent);
}

export function setExecutorState(pi: ExtensionAPI, cwd: string, state: ExecutorRuntimeState): void {
  statesByCwd.set(cwd, state);
  emitExecutorState(pi, cwd, state);
}

export function clearExecutorState(pi: ExtensionAPI, cwd: string): void {
  statesByCwd.delete(cwd);
  emitExecutorState(pi, cwd, { kind: "idle" });
}

function toReadyState(endpoint: ExecutorEndpoint): ExecutorRuntimeState {
  return {
    kind: "ready",
    label: endpoint.label,
    mcpUrl: endpoint.mcpUrl,
    webUrl: endpoint.webUrl,
  };
}

export async function connectExecutor(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "cwd">,
): Promise<ExecutorEndpoint> {
  setExecutorState(pi, ctx.cwd, { kind: "connecting" });

  try {
    const endpoint = await resolveExecutorEndpoint();
    setExecutorState(pi, ctx.cwd, toReadyState(endpoint));
    return endpoint;
  } catch (error) {
    const message = errorMessage(error);
    setExecutorState(pi, ctx.cwd, { kind: "error", message });
    throw error;
  }
}

export function formatExecutorRuntimeState(state: ExecutorRuntimeState): string[] {
  switch (state.kind) {
    case "idle":
      return ["Executor idle"];
    case "ready":
      return [
        "Executor ready",
        `candidate: ${state.label}`,
        `mcpUrl: ${state.mcpUrl}`,
        `webUrl: ${state.webUrl}`,
      ];
    case "connecting":
      return ["Executor connecting"];
    case "error":
      return ["Executor error", state.message];
  }

  return ["Executor idle"];
}
