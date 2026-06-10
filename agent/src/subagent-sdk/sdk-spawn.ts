import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";

import type {
  StartSubagentResult,
  StartSubagentParams,
  StartSubagentParamsJsonSchema,
  StartSubagentParamsText,
  StructuredOutputError,
  TSchemaBase,
} from "./types.js";
import type {
  StartSubagentSpawnOutcomeJsonSchema,
  StartSubagentSpawnOutcomeText,
  SubagentHandle,
  SubagentSDK,
} from "./sdk-types.js";

export const DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT = 3;

function toStructuredOutputError(
  state: { status: string; summary?: string; structuredError?: StructuredOutputError },
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
      message:
        state.summary ??
        "Subagent execution failed before returning structured output. StructuredOutput tool may have been unavailable or not called.",
      retryCount,
      attempts: retryCount,
    };
  }
  return {
    code: "missing_tool_call",
    message:
      "Subagent completed without structured output. StructuredOutput tool may have been unavailable or not called.",
    retryCount,
    attempts: retryCount,
  };
}

function toSpawnAbortedError(
  error: unknown,
  retryCount = DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT,
): StructuredOutputError {
  const message = errorMessage(error);
  return { code: "aborted", message, retryCount, attempts: 0 };
}

function getSpawnRetryCount(params: StartSubagentParams): number {
  return params.outputFormat?.type === "json_schema"
    ? (params.outputFormat.retryCount ?? DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT)
    : DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT;
}

function prepareBlockingSpawnParams(params: StartSubagentParams): StartSubagentParams {
  if (params.outputFormat?.type !== "json_schema" || params.completion !== undefined) {
    return params;
  }

  return { ...params, completion: false };
}

async function resolveSpawnOutcome(
  params: StartSubagentParams,
  handle: SubagentHandle,
  prompt: string,
  signal: AbortSignal | undefined,
  retryCount: number,
): Promise<StartSubagentSpawnOutcomeText | StartSubagentSpawnOutcomeJsonSchema<TSchemaBase>> {
  if (params.outputFormat?.type !== "json_schema") {
    return { ok: true as const, value: { handle, prompt } };
  }
  try {
    const terminal = await handle.waitForCompletion({ signal });
    if (terminal.status === "completed" && terminal.structured !== undefined) {
      return {
        ok: true as const,
        value: {
          handle,
          prompt,
          state: terminal,
          structured: terminal.structured as Static<TSchemaBase>,
        },
      };
    }
    return { ok: false as const, error: toStructuredOutputError(terminal, retryCount) };
  } catch (error) {
    return { ok: false as const, error: toSpawnAbortedError(error, retryCount) };
  }
}

type SpawnFunctionFactoryInput = {
  runtime: {
    spawn(
      params: StartSubagentParams,
      ctx: ExtensionContext,
      onUpdate?: AgentToolUpdateCallback,
      signal?: AbortSignal,
    ): Promise<StartSubagentResult>;
  };
  emitChangedStates: () => void;
  toHandle: (sessionId: string) => SubagentHandle;
};

export function createSpawnFunction(input: SpawnFunctionFactoryInput): SubagentSDK["spawn"] {
  async function spawn(
    params: StartSubagentParamsText,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
  ): Promise<StartSubagentSpawnOutcomeText>;
  async function spawn<TSchemaValue extends TSchemaBase>(
    params: StartSubagentParamsJsonSchema<TSchemaValue>,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
  ): Promise<StartSubagentSpawnOutcomeJsonSchema<TSchemaValue>>;
  async function spawn(
    params: StartSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
  ): Promise<StartSubagentSpawnOutcomeText | StartSubagentSpawnOutcomeJsonSchema<TSchemaBase>> {
    const retryCount = getSpawnRetryCount(params);
    try {
      const started = await input.runtime.spawn(
        prepareBlockingSpawnParams(params),
        ctx,
        onUpdate,
        signal,
      );
      input.emitChangedStates();
      const handle = input.toHandle(started.state.sessionId);
      return await resolveSpawnOutcome(params, handle, started.prompt, signal, retryCount);
    } catch (error) {
      return { ok: false as const, error: toSpawnAbortedError(error, retryCount) };
    }
  }
  return spawn;
}
import { errorMessage } from "../utils/error-message.js";
