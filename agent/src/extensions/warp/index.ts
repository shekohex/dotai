import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";
import { GOAL_BLOCKED_EVENT, GoalBlockedEventSchema } from "../goal/types.js";
import {
  createWarpCliAgentPayload,
  createWarpCliAgentSequence,
  negotiateWarpCliAgentProtocolVersion,
} from "./encoder.js";
import { warpRuntime, writeWarpCliAgentSequence } from "./runtime.js";
import type {
  WarpCliAgentEvent,
  WarpCliAgentPayload,
  WarpCliAgentPayloadOptions,
} from "./types.js";

export interface WarpExtensionRuntime {
  readProtocolVersion(): string | undefined;
  emitPayload(payload: WarpCliAgentPayload): void;
}

export const defaultWarpExtensionRuntime: WarpExtensionRuntime = {
  readProtocolVersion: () => warpRuntime.readProtocolVersion(),
  emitPayload: (payload) => {
    writeWarpCliAgentSequence(createWarpCliAgentSequence(payload));
  },
};

const truncateWarpText = (text: string, maxLength = 200): string => {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
};

const createGoalBlockedSummary = (blockedReason: string): string =>
  truncateWarpText(`Goal blocked: ${blockedReason}`);

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
  typeof part === "object" &&
  part !== null &&
  "type" in part &&
  part.type === "text" &&
  "text" in part &&
  typeof part.text === "string";

const extractMessageText = (message: AgentMessage): string => {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter(isTextPart)
    .map((part) => part.text)
    .join(" ");
};

const getLastMessageText = (messages: AgentMessage[], role: "assistant"): string | undefined => {
  const message = messages.findLast((candidate) => candidate.role === role);
  if (message === undefined) return undefined;
  const text = extractMessageText(message);
  if (text.length === 0) return undefined;
  return truncateWarpText(text);
};

const emitWarpEvent = (
  runtime: WarpExtensionRuntime,
  event: WarpCliAgentEvent,
  ctx: ExtensionContext,
  options: WarpCliAgentPayloadOptions = {},
): void => {
  const protocolVersion = negotiateWarpCliAgentProtocolVersion(runtime.readProtocolVersion());
  if (protocolVersion === null) return;
  runtime.emitPayload(createWarpCliAgentPayload(event, ctx, protocolVersion, options));
};

export const createWarpExtension = (runtime: WarpExtensionRuntime = defaultWarpExtensionRuntime) =>
  function warpExtension(pi: ExtensionAPI): void {
    let currentContext: ExtensionContext | null = null;

    pi.on("session_start", (_event, ctx) => {
      currentContext = ctx;
      emitWarpEvent(runtime, "session_start", ctx, { plugin_version: "builtin" });
    });

    pi.on("input", (event, ctx) => {
      currentContext = ctx;
      emitWarpEvent(runtime, "prompt_submit", ctx, { query: truncateWarpText(event.text) });
      return { action: "continue" };
    });

    pi.on("agent_end", (event, ctx) => {
      currentContext = ctx;
      emitWarpEvent(runtime, "stop", ctx, {
        query: pi.getSessionName() ?? undefined,
        response: getLastMessageText(event.messages, "assistant"),
      });
    });

    pi.on("tool_execution_end", (event, ctx) => {
      currentContext = ctx;
      emitWarpEvent(runtime, "tool_complete", ctx, { tool_name: event.toolName });
    });

    pi.on("tool_execution_update", (event, ctx) => {
      currentContext = ctx;
      if (event.toolName !== "interview") return;
      emitWarpEvent(runtime, "question_asked", ctx, { summary: "Question asked" });
    });

    pi.events.on(GOAL_BLOCKED_EVENT, (data) => {
      if (currentContext === null || !Value.Check(GoalBlockedEventSchema, data)) return;
      emitWarpEvent(runtime, "question_asked", currentContext, {
        summary: createGoalBlockedSummary(data.blockedReason),
      });
    });
  };

export default createWarpExtension();
