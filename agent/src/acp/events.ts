import { isAbsolute, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  AcpSessionEvent,
  AcpStopReason,
  AcpToolContent,
  AcpToolKind,
  AcpToolLocation,
} from "./core.js";
import { isRecord } from "../utils/unknown-data.js";

export function projectAgentSessionEvent(
  session: AgentSession,
  event: AgentSessionEvent,
): AcpSessionEvent | undefined {
  if (event.type === "message_update") {
    if (event.assistantMessageEvent.type === "text_delta") {
      return {
        type: "text",
        text: event.assistantMessageEvent.delta,
      };
    }
    if (event.assistantMessageEvent.type === "thinking_delta") {
      return {
        type: "thought",
        text: event.assistantMessageEvent.delta,
      };
    }
  }
  if (event.type === "agent_settled") {
    return { type: "settled", stopReason: stopReason(session) };
  }
  if (event.type === "tool_execution_start") {
    const locations = toolLocations(event.args, session.sessionManager.getCwd());
    return {
      type: "tool_start",
      toolCallId: event.toolCallId,
      name: event.toolName,
      title: toolTitle(event.toolName, event.args, locations),
      kind: toolKind(event.toolName),
      rawInput: event.args,
      locations: locations.length === 0 ? undefined : locations,
    };
  }
  if (event.type === "tool_execution_update") {
    return {
      type: "tool_update",
      toolCallId: event.toolCallId,
      name: event.toolName,
      content: toolContent(event.partialResult),
      rawOutput: event.partialResult,
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "tool_end",
      toolCallId: event.toolCallId,
      name: event.toolName,
      status: event.isError ? "failed" : "completed",
      content: toolContent(event.result),
      rawOutput: event.result,
    };
  }
  return undefined;
}

function toolKind(toolName: string): AcpToolKind {
  if (toolName === "read") return "read";
  if (["write", "edit", "apply_patch", "fff"].includes(toolName)) return "edit";
  if (toolName.includes("delete")) return "delete";
  if (toolName.includes("move")) return "move";
  if (["find", "grep", "ls", "search", "session_query"].includes(toolName)) return "search";
  if (["bash", "execute", "subagent", "workflow"].includes(toolName)) return "execute";
  if (toolName.includes("think")) return "think";
  if (["websearch", "webfetch"].includes(toolName)) return "fetch";
  if (toolName === "mode") return "switch_mode";
  return "other";
}

function toolLocations(value: unknown, cwd: string): AcpToolLocation[] {
  if (!isRecord(value)) return [];
  const path = value.path;
  if (typeof path !== "string") return [];
  const line = typeof value.line === "number" ? value.line : undefined;
  return [{ path: isAbsolute(path) ? path : resolve(cwd, path), line }];
}

function toolTitle(toolName: string, args: unknown, locations: AcpToolLocation[]): string {
  if (toolName === "bash" && isRecord(args) && typeof args.command === "string") {
    return args.command;
  }
  const path = locations[0]?.path;
  return path === undefined ? toolName : `${toolName} ${path}`;
}

function toolContent(value: unknown): AcpToolContent[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
  const content: AcpToolContent[] = [];
  for (const block of value.content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return content.length === 0 ? undefined : content;
}

function stopReason(session: AgentSession): AcpStopReason {
  const message = session.messages.toReversed().find((candidate) => candidate.role === "assistant");
  if (message?.role !== "assistant") return "end_turn";
  switch (message.stopReason) {
    case "aborted":
      return "cancelled";
    case "length":
      return "max_tokens";
    case "error":
      return "refusal";
    case "deferred":
    case "pending":
    case "stop":
    case "toolUse":
      return "end_turn";
  }
  return "end_turn";
}
