import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { readNumber } from "../utils/unknown-data.js";
import type { SessionSnapshot } from "./schemas.js";

type TransportTranscriptMessage = SessionSnapshot["transcript"][number];
type JsonTransportValue =
  | string
  | number
  | boolean
  | null
  | JsonTransportValue[]
  | { [key: string]: JsonTransportValue };
type TransportTranscript = SessionSnapshot["transcript"];

export function toTransportTranscript(messages: AgentMessage[]): TransportTranscript {
  return messages.map((message) => toTransportTranscriptMessage(message));
}

export function fromTransportTranscript(
  messages: readonly TransportTranscriptMessage[],
): AgentMessage[] {
  return messages.map((message) => fromTransportTranscriptMessage(message));
}

function toTransportTranscriptMessage(message: AgentMessage): TransportTranscriptMessage {
  switch (message.role) {
    case "user":
      return structuredClone(message);
    case "assistant":
      return structuredClone(message);
    case "toolResult": {
      const toolResultDetails = toJsonTransportValue(message.details);
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: structuredClone(message.content),
        isError: message.isError,
        timestamp: message.timestamp,
        ...(toolResultDetails === undefined ? {} : { details: toolResultDetails }),
      };
    }
    case "bashExecution":
      return {
        ...structuredClone(message),
        exitCode: message.exitCode,
      };
    case "custom": {
      const customDetails = toJsonTransportValue(message.details);
      return {
        role: "custom",
        customType: message.customType,
        content: structuredClone(message.content),
        display: message.display,
        timestamp: message.timestamp,
        ...(customDetails === undefined ? {} : { details: customDetails }),
      };
    }
    case "branchSummary":
      return structuredClone(message);
    case "compactionSummary":
      return structuredClone(message);
  }

  throw new Error("Unsupported transcript message");
}

function fromTransportTranscriptMessage(message: TransportTranscriptMessage): AgentMessage {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: structuredClone(message.content),
        timestamp: readMessageTimestamp(message.timestamp),
      };
    case "developer":
      return {
        role: "user",
        content: structuredClone(message.content),
        timestamp: readMessageTimestamp(message.timestamp),
      };
    case "assistant":
      return {
        role: "assistant",
        content: structuredClone(message.content),
        api: message.api ?? "unknown",
        provider: message.provider ?? "unknown",
        model: message.model ?? "unknown",
        responseId: message.responseId,
        usage: message.usage ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: message.stopReason ?? "stop",
        errorMessage: message.errorMessage,
        timestamp: readMessageTimestamp(message.timestamp),
      };
    case "toolResult":
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: structuredClone(message.content),
        isError: message.isError,
        timestamp: readMessageTimestamp(message.timestamp),
        details: message.details,
      };
    case "bashExecution":
      return {
        role: "bashExecution",
        command: message.command,
        output: message.output,
        exitCode: message.exitCode,
        cancelled: message.cancelled,
        truncated: message.truncated,
        fullOutputPath: message.fullOutputPath,
        timestamp: readMessageTimestamp(message.timestamp),
        excludeFromContext: message.excludeFromContext,
      };
    case "custom":
      return {
        role: "custom",
        customType: message.customType,
        content: structuredClone(message.content),
        display: message.display,
        timestamp: readMessageTimestamp(message.timestamp),
        details: message.details,
      };
    case "branchSummary":
      return {
        role: "branchSummary",
        summary: message.summary,
        fromId: message.fromId,
        timestamp: readMessageTimestamp(message.timestamp),
      };
    case "compactionSummary":
      return {
        role: "compactionSummary",
        summary: message.summary,
        tokensBefore: message.tokensBefore,
        timestamp: readMessageTimestamp(message.timestamp),
      };
  }

  throw new Error("Unsupported transport transcript message");
}

function readMessageTimestamp(value: unknown): number {
  const numberValue = readNumber(value);
  if (numberValue !== undefined) {
    return numberValue;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function toJsonTransportValue(value: unknown): JsonTransportValue | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const items: JsonTransportValue[] = [];
    for (const item of value) {
      const converted = toJsonTransportValue(item);
      if (converted === undefined) {
        return undefined;
      }
      items.push(converted);
    }
    return items;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    const record: { [key: string]: JsonTransportValue } = {};
    for (const [key, item] of entries) {
      const converted = toJsonTransportValue(item);
      if (converted === undefined) {
        return undefined;
      }
      record[key] = converted;
    }
    return record;
  }

  return undefined;
}
