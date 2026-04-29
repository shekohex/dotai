import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
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
      scopeId: string;
      scopeDir: string;
    }
  | { kind: "error"; message: string };

export type ExecutorUpdatedEvent = {
  cwd: string;
  state: ExecutorRuntimeState;
};

export const EXECUTOR_UPDATED_EVENT = "executor:updated";

const hydratedExecutorStateSymbol = Symbol.for("@shekohex/agent/executor-runtime-state");

type SessionManagerWithHydratedExecutorState = {
  [hydratedExecutorStateSymbol]?: ExecutorRuntimeState;
};

const statesByCwd = new Map<string, ExecutorRuntimeState>();

export const ExecutorRuntimeStateSchema = Type.Union([
  Type.Object({ kind: Type.Literal("idle") }),
  Type.Object({ kind: Type.Literal("connecting") }),
  Type.Object({ kind: Type.Literal("error"), message: Type.String() }),
  Type.Object({
    kind: Type.Literal("ready"),
    label: Type.String(),
    mcpUrl: Type.String(),
    webUrl: Type.String(),
    scopeId: Type.String(),
    scopeDir: Type.String(),
  }),
]);

export function getExecutorState(cwd: string): ExecutorRuntimeState {
  return statesByCwd.get(cwd) ?? { kind: "idle" };
}

export function applyExecutorUpdatedEvent(data: unknown): void {
  if (data === null || typeof data !== "object" || !("cwd" in data) || !("state" in data)) {
    return;
  }

  const cwd = data.cwd;
  const state = data.state;
  if (typeof cwd !== "string" || !Value.Check(ExecutorRuntimeStateSchema, state)) {
    return;
  }

  statesByCwd.set(cwd, Value.Parse(ExecutorRuntimeStateSchema, state));
}

export function hydrateExecutorState(cwd: string, state: ExecutorRuntimeState): void {
  statesByCwd.set(cwd, Value.Parse(ExecutorRuntimeStateSchema, state));
}

export function seedHydratedExecutorState(
  sessionManager: object,
  state: ExecutorRuntimeState,
): void {
  const hydratedSessionManager = sessionManager as SessionManagerWithHydratedExecutorState;
  hydratedSessionManager[hydratedExecutorStateSymbol] = Value.Parse(
    ExecutorRuntimeStateSchema,
    state,
  );
}

export function readHydratedExecutorState(
  sessionManager: object | undefined,
): ExecutorRuntimeState | undefined {
  if (sessionManager === undefined) {
    return undefined;
  }

  const hydratedSessionManager = sessionManager as SessionManagerWithHydratedExecutorState;
  const state = hydratedSessionManager[hydratedExecutorStateSymbol];
  if (!Value.Check(ExecutorRuntimeStateSchema, state)) {
    return undefined;
  }

  return Value.Parse(ExecutorRuntimeStateSchema, state);
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
    scopeId: endpoint.scope.id,
    scopeDir: endpoint.scope.dir,
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
        `scopeId: ${state.scopeId}`,
        `scopeDir: ${state.scopeDir}`,
      ];
    case "connecting":
      return ["Executor connecting"];
    case "error":
      return ["Executor error", state.message];
  }

  return ["Executor idle"];
}
