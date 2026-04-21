import type { AgentToolUpdateCallback, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";

import type { SubagentRuntimeEvent } from "./events.js";
import type { PaneCapture } from "./mux.js";
import type {
  CancelSubagentParams,
  MessageSubagentParams,
  MessageSubagentResult,
  ResumeSubagentParams,
  RuntimeSubagent,
  SpawnOutcome,
  StartSubagentParamsJsonSchema,
  StartSubagentParamsText,
  StructuredOutputError,
  TSchemaBase,
} from "./types.js";

export type SubagentSDKEvent = SubagentRuntimeEvent;

export interface SubagentHandle {
  readonly sessionId: string;
  getState(): RuntimeSubagent;
  sendMessage(
    params: Omit<MessageSubagentParams, "sessionId">,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<MessageSubagentResult>;
  cancel(): Promise<RuntimeSubagent>;
  waitForCompletion(options?: { signal?: AbortSignal }): Promise<RuntimeSubagent>;
  captureOutput(lines?: number): Promise<PaneCapture>;
  onEvent(listener: (event: SubagentSDKEvent) => void): () => void;
}

export type StartSubagentSpawnValue = {
  handle: SubagentHandle;
  prompt: string;
};

export type StartSubagentSpawnStructuredValue<TSchemaValue extends TSchemaBase> = {
  handle: SubagentHandle;
  prompt: string;
  state: RuntimeSubagent;
  structured: Static<TSchemaValue>;
};

export type StartSubagentSpawnOutcomeText = SpawnOutcome<
  StartSubagentSpawnValue,
  StructuredOutputError
>;
export type StartSubagentSpawnOutcomeJsonSchema<TSchemaValue extends TSchemaBase> = SpawnOutcome<
  StartSubagentSpawnStructuredValue<TSchemaValue>,
  StructuredOutputError
>;

export interface SubagentSDK {
  restore(ctx: ExtensionContext): Promise<SubagentHandle[]>;
  spawn(
    params: StartSubagentParamsText,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
  ): Promise<StartSubagentSpawnOutcomeText>;
  spawn<TSchemaValue extends TSchemaBase>(
    params: StartSubagentParamsJsonSchema<TSchemaValue>,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
  ): Promise<StartSubagentSpawnOutcomeJsonSchema<TSchemaValue>>;
  resume(
    params: ResumeSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<{ handle: SubagentHandle; prompt: string }>;
  message(
    params: MessageSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<{ handle: SubagentHandle; result: MessageSubagentResult }>;
  cancel(params: CancelSubagentParams): Promise<RuntimeSubagent>;
  get(sessionId: string): SubagentHandle | undefined;
  list(): RuntimeSubagent[];
  captureOutput(params: { sessionId: string; lines?: number }): Promise<PaneCapture>;
  onEvent(listener: (event: SubagentSDKEvent) => void): () => void;
  dispose(): void;
}
