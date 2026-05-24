import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { GOAL_BLOCKED_EVENT, GoalBlockedEventSchema } from "../goal/types.js";
import {
  createWarpCliAgentPayload,
  createWarpCliAgentSequence,
  negotiateWarpCliAgentProtocolVersion,
} from "./encoder.js";
import { warpRuntime, writeWarpCliAgentSequence } from "./runtime.js";
import { extractLastAssistantText, formatNotification } from "../terminal-notify.js";
import { isChildSession, readChildState } from "../../subagent-sdk/index.js";
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

const formatAssistantSummary = (
  messages: Parameters<typeof extractLastAssistantText>[0],
): string | undefined => formatNotification(extractLastAssistantText(messages))?.body;

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
    const childState = readChildState();
    let currentContext: ExtensionContext | null = null;

    const emitIfParentSession = (
      event: WarpCliAgentEvent,
      ctx: ExtensionContext,
      options: WarpCliAgentPayloadOptions = {},
    ): void => {
      if (isChildSession(childState, ctx)) return;
      currentContext = ctx;
      emitWarpEvent(runtime, event, ctx, options);
    };

    pi.on("session_start", (_event, ctx) => {
      emitIfParentSession("session_start", ctx, { plugin_version: "builtin" });
    });

    pi.on("input", (event, ctx) => {
      emitIfParentSession("prompt_submit", ctx, { query: truncateWarpText(event.text) });
      return { action: "continue" };
    });

    pi.on("agent_end", (event, ctx) => {
      emitIfParentSession("stop", ctx, {
        query: pi.getSessionName() ?? undefined,
        response: formatAssistantSummary(event.messages),
      });
    });

    pi.on("tool_execution_end", (event, ctx) => {
      emitIfParentSession("tool_complete", ctx, { tool_name: event.toolName });
    });

    pi.on("tool_execution_update", (event, ctx) => {
      if (event.toolName !== "interview") return;
      emitIfParentSession("question_asked", ctx, { summary: "Question asked" });
    });

    pi.events.on(GOAL_BLOCKED_EVENT, (data) => {
      if (currentContext === null || !Value.Check(GoalBlockedEventSchema, data)) return;
      emitWarpEvent(runtime, "question_asked", currentContext, {
        summary: createGoalBlockedSummary(data.blockedReason),
      });
    });
  };

export default createWarpExtension();
