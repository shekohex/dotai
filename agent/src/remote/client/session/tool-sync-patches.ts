import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { JsonValue } from "../../json-schema.js";
import type { SessionSyncEvent } from "../../schemas.js";
import { applyToolPartialPatch, appendToolOutputTextDelta } from "../../tool-output-text.js";

type ToolExecutionPatchPayload = Extract<
  Extract<SessionSyncEvent, { type: "patch" }>["patch"],
  { patchType: "tool.execution" }
>["payload"];

export type ActiveSyncToolExecutionState = {
  toolName: string;
  args: unknown;
  partialResult?: JsonValue;
};

export function applyToolExecutionSyncPatch(input: {
  payload: ToolExecutionPatchPayload;
  activeSyncToolExecutions: Map<string, ActiveSyncToolExecutionState>;
  applyAgentSessionEvent: (event: AgentSessionEvent) => void;
}): void {
  if (input.payload.type === "tool_execution_start") {
    input.activeSyncToolExecutions.set(input.payload.toolCallId, {
      toolName: input.payload.toolName,
      args: input.payload.args,
      partialResult: undefined,
    });
    input.applyAgentSessionEvent(input.payload);
    return;
  }

  const activeExecution = input.activeSyncToolExecutions.get(input.payload.toolCallId);
  if (!activeExecution) {
    return;
  }

  if (input.payload.type === "tool_execution_output_delta") {
    const partialResult = appendToolOutputDelta(
      activeExecution.partialResult,
      input.payload.start,
      input.payload.delta,
    );
    if (partialResult === undefined) {
      return;
    }

    activeExecution.partialResult = partialResult;
    input.applyAgentSessionEvent({
      type: "tool_execution_update",
      toolCallId: input.payload.toolCallId,
      toolName: activeExecution.toolName,
      args: activeExecution.args,
      partialResult,
    });
    return;
  }

  if (input.payload.type === "tool_execution_partial_patch") {
    const partialResult = applyToolPartialPatch(activeExecution.partialResult, input.payload.ops);
    if (partialResult === undefined) {
      return;
    }

    activeExecution.partialResult = partialResult;
    input.applyAgentSessionEvent({
      type: "tool_execution_update",
      toolCallId: input.payload.toolCallId,
      toolName: activeExecution.toolName,
      args: activeExecution.args,
      partialResult,
    });
    return;
  }

  if (input.payload.type === "tool_execution_update") {
    activeExecution.partialResult = input.payload.partialResult;
    input.applyAgentSessionEvent({
      type: "tool_execution_update",
      toolCallId: input.payload.toolCallId,
      toolName: activeExecution.toolName,
      args: activeExecution.args,
      partialResult: input.payload.partialResult,
    });
    return;
  }

  input.activeSyncToolExecutions.delete(input.payload.toolCallId);
  input.applyAgentSessionEvent({
    type: "tool_execution_end",
    toolCallId: input.payload.toolCallId,
    toolName: activeExecution.toolName,
    result: input.payload.result,
    isError: input.payload.isError,
  });
}

function appendToolOutputDelta(current: JsonValue | undefined, start: number, delta: string) {
  return isAppendableToolOutput(current) && current.content[0].text.length === start
    ? appendToolOutputTextDelta(current, delta)
    : undefined;
}

function isAppendableToolOutput(value: JsonValue | undefined): value is {
  content: [{ type: "text"; text: string }];
  details?: JsonValue;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const { content } = value;
  if (!Array.isArray(content) || content.length !== 1) {
    return false;
  }

  const [firstContent] = content;
  return (
    typeof firstContent === "object" &&
    firstContent !== null &&
    !Array.isArray(firstContent) &&
    firstContent.type === "text" &&
    typeof firstContent.text === "string"
  );
}
