import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";

import { SubagentRuntimeEventBus, type SubagentRuntimeEvent } from "./events.js";
import type { PaneCapture, MuxAdapter } from "./mux.js";
import { SubagentRuntime } from "./runtime.js";
import type { LaunchCommandBuilder } from "./launch.js";
import type {
  CancelSubagentParams,
  MessageSubagentParams,
  MessageSubagentResult,
  ResumeSubagentParams,
  RuntimeSubagent,
  SpawnOutcome,
  StartSubagentParams,
  StartSubagentParamsJsonSchema,
  StartSubagentParamsText,
  StructuredOutputError,
  TSchemaBase,
} from "./types.js";
import { cloneRuntimeSubagent } from "./types.js";
import type { SubagentRuntimeHooks } from "./runtime-hooks.js";

const SDK_EVENT_POLL_INTERVAL_MS = 500;
const DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT = 3;

function isTerminalStatus(status: RuntimeSubagent["status"]): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function getStateOrThrow(runtime: SubagentRuntime, sessionId: string): RuntimeSubagent {
  const state = runtime.listStates().find((candidate) => candidate.sessionId === sessionId);
  if (!state) {
    throw new Error(`Unknown subagent sessionId: ${sessionId}`);
  }

  return state;
}

function toStructuredOutputError(
  state: RuntimeSubagent,
  retryCount = DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT,
): StructuredOutputError {
  if (state.structuredError) {
    return state.structuredError;
  }

  if (state.status === "cancelled") {
    return {
      code: "aborted",
      message: state.summary ?? "Subagent execution was cancelled.",
      retryCount,
      attempts: retryCount,
    };
  }

  if (state.status === "failed") {
    return {
      code: "aborted",
      message: state.summary ?? "Subagent execution failed.",
      retryCount,
      attempts: retryCount,
    };
  }

  return {
    code: "missing_tool_call",
    message: "Subagent completed without structured output.",
    retryCount,
    attempts: retryCount,
  };
}

function toSpawnAbortedError(
  error: unknown,
  retryCount = DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT,
): StructuredOutputError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "aborted",
    message,
    retryCount,
    attempts: 0,
  };
}

type StartSubagentSpawnValue = {
  handle: SubagentHandle;
  prompt: string;
};

type StartSubagentSpawnStructuredValue<TSchemaValue extends TSchemaBase> = {
  handle: SubagentHandle;
  prompt: string;
  state: RuntimeSubagent;
  structured: Static<TSchemaValue>;
};

type StartSubagentSpawnOutcomeText = SpawnOutcome<StartSubagentSpawnValue, StructuredOutputError>;
type StartSubagentSpawnOutcomeJsonSchema<TSchemaValue extends TSchemaBase> = SpawnOutcome<
  StartSubagentSpawnStructuredValue<TSchemaValue>,
  StructuredOutputError
>;

export type SubagentSDKEvent = SubagentRuntimeEvent;

export interface SubagentHandle {
  readonly sessionId: string;
  getState(): RuntimeSubagent;
  sendMessage(
    params: Omit<MessageSubagentParams, "sessionId">,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
  ): Promise<MessageSubagentResult>;
  cancel(): Promise<RuntimeSubagent>;
  waitForCompletion(options?: { signal?: AbortSignal }): Promise<RuntimeSubagent>;
  captureOutput(lines?: number): Promise<PaneCapture>;
  onEvent(listener: (event: SubagentSDKEvent) => void): () => void;
}

export interface SubagentSDK {
  restore(ctx: ExtensionContext): Promise<SubagentHandle[]>;
  spawn(
    params: StartSubagentParamsText,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
    signal?: AbortSignal,
  ): Promise<StartSubagentSpawnOutcomeText>;
  spawn<TSchemaValue extends TSchemaBase>(
    params: StartSubagentParamsJsonSchema<TSchemaValue>,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
    signal?: AbortSignal,
  ): Promise<StartSubagentSpawnOutcomeJsonSchema<TSchemaValue>>;
  resume(
    params: ResumeSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
  ): Promise<{ handle: SubagentHandle; prompt: string }>;
  message(
    params: MessageSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
  ): Promise<{ handle: SubagentHandle; result: MessageSubagentResult }>;
  cancel(params: CancelSubagentParams): Promise<RuntimeSubagent>;
  get(sessionId: string): SubagentHandle | undefined;
  list(): RuntimeSubagent[];
  captureOutput(params: { sessionId: string; lines?: number }): Promise<PaneCapture>;
  onEvent(listener: (event: SubagentSDKEvent) => void): () => void;
  dispose(): void;
}

type CreateSubagentSDKOptions = {
  adapter: MuxAdapter;
  buildLaunchCommand: LaunchCommandBuilder;
  hooks?: SubagentRuntimeHooks;
};

class SDKSubagentHandle implements SubagentHandle {
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
    onUpdate?: AgentToolUpdateCallback<any>,
  ): Promise<MessageSubagentResult> {
    return this.sdk
      .message({ ...params, sessionId: this.sessionId }, ctx, onUpdate)
      .then((result) => result.result);
  }

  cancel(): Promise<RuntimeSubagent> {
    return this.sdk.cancel({ sessionId: this.sessionId });
  }

  waitForCompletion(options: { signal?: AbortSignal } = {}): Promise<RuntimeSubagent> {
    const currentState = this.getState();
    if (isTerminalStatus(currentState.status)) {
      return Promise.resolve(currentState);
    }

    return new Promise<RuntimeSubagent>((resolve, reject) => {
      let cleanup = () => {};

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

      if (options.signal?.aborted) {
        abortHandler();
        return;
      }

      options.signal?.addEventListener("abort", abortHandler, { once: true });
    });
  }

  captureOutput(lines?: number): Promise<PaneCapture> {
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

export function createSubagentSDK(
  pi: ExtensionAPI,
  options: CreateSubagentSDKOptions,
): SubagentSDK {
  const runtime = new SubagentRuntime(
    pi,
    options.adapter,
    options.buildLaunchCommand,
    options.hooks,
  );
  const eventBus = new SubagentRuntimeEventBus();
  const timer = setInterval(() => {
    emitChangedStates();
  }, SDK_EVENT_POLL_INTERVAL_MS);

  timer.unref?.();

  function emitChangedStates(): void {
    eventBus.emitChangedStates(runtime.listStates());
  }

  function toHandle(sessionId: string): SubagentHandle {
    return new SDKSubagentHandle(sdk, sessionId);
  }

  async function spawn(
    params: StartSubagentParamsText,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
    signal?: AbortSignal,
  ): Promise<StartSubagentSpawnOutcomeText>;
  async function spawn<TSchemaValue extends TSchemaBase>(
    params: StartSubagentParamsJsonSchema<TSchemaValue>,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
    signal?: AbortSignal,
  ): Promise<StartSubagentSpawnOutcomeJsonSchema<TSchemaValue>>;
  async function spawn(
    params: StartSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
    signal?: AbortSignal,
  ): Promise<StartSubagentSpawnOutcomeText | StartSubagentSpawnOutcomeJsonSchema<TSchemaBase>> {
    const retryCount =
      params.outputFormat?.type === "json_schema"
        ? (params.outputFormat.retryCount ?? DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT)
        : DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT;

    try {
      const started = await runtime.spawn(params, ctx, onUpdate, signal);
      emitChangedStates();

      const handle = toHandle(started.state.sessionId);
      if (params.outputFormat?.type !== "json_schema") {
        return {
          ok: true as const,
          value: {
            handle,
            prompt: started.prompt,
          },
        };
      }

      try {
        const terminal = await handle.waitForCompletion({ signal });
        if (terminal.status === "completed" && terminal.structured !== undefined) {
          return {
            ok: true as const,
            value: {
              handle,
              prompt: started.prompt,
              state: terminal,
              structured: terminal.structured as Static<TSchemaBase>,
            },
          };
        }

        return {
          ok: false as const,
          error: toStructuredOutputError(terminal, retryCount),
        };
      } catch (error) {
        return {
          ok: false as const,
          error: toSpawnAbortedError(error, retryCount),
        };
      }
    } catch (error) {
      return {
        ok: false as const,
        error: toSpawnAbortedError(error, retryCount),
      };
    }
  }

  const sdk: SubagentSDK = {
    async restore(ctx) {
      await runtime.restore(ctx);
      emitChangedStates();
      return runtime.listStates().map((state) => toHandle(state.sessionId));
    },
    spawn,
    async resume(params, ctx, onUpdate) {
      const resumed = await runtime.resume(params, ctx, onUpdate);
      emitChangedStates();
      return {
        handle: toHandle(resumed.state.sessionId),
        prompt: resumed.prompt,
      };
    },
    async message(params, ctx, onUpdate) {
      const result = await runtime.message(params, ctx, onUpdate);
      emitChangedStates();
      return {
        handle: toHandle(result.state.sessionId),
        result,
      };
    },
    async cancel(params) {
      const cancelled = await runtime.cancel(params);
      emitChangedStates();
      return cancelled;
    },
    get(sessionId) {
      return runtime.listStates().some((state) => state.sessionId === sessionId)
        ? toHandle(sessionId)
        : undefined;
    },
    list() {
      return runtime.listStates();
    },
    async captureOutput({ sessionId, lines }) {
      const state = getStateOrThrow(runtime, sessionId);
      return options.adapter.capturePane(state.paneId, lines);
    },
    onEvent(listener) {
      return eventBus.subscribe(listener);
    },
    dispose() {
      clearInterval(timer);
      runtime.dispose();
    },
  };

  return sdk;
}
