import type {
  SessionEntry,
  SessionMessageEntry,
} from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
  parseSubagentStructuredOutputEntry,
  type StructuredOutputError,
} from "./types.js";

export type ExpiringMarker = {
  expiresAt?: number;
};

export type TimeoutModeMarker = {
  activatedAt?: number;
};

export type AssistantOutcomeMessage = SessionMessageEntry["message"] & {
  role: "assistant";
  stopReason?: string;
  content: string | Array<{ type: string; text?: string }>;
};

export type StructuredOutputEntry = {
  structured?: unknown;
  error?: StructuredOutputError;
};

const ExpiringMarkerSchema = Type.Object(
  {
    expiresAt: Type.Number(),
  },
  { additionalProperties: true },
);

const TimeoutModeMarkerSchema = Type.Object(
  {
    activatedAt: Type.Number(),
  },
  { additionalProperties: true },
);

export function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseExpiringMarker(value: unknown): ExpiringMarker | undefined {
  if (!Value.Check(ExpiringMarkerSchema, value)) {
    return undefined;
  }

  return Value.Parse(ExpiringMarkerSchema, value);
}

export function parseTimeoutModeMarker(value: unknown): TimeoutModeMarker | undefined {
  if (!Value.Check(TimeoutModeMarkerSchema, value)) {
    return undefined;
  }

  return Value.Parse(TimeoutModeMarkerSchema, value);
}

export function getAssistantOutcomeMessage(
  entry: SessionEntry,
): AssistantOutcomeMessage | undefined {
  if (
    entry.type !== "message" ||
    entry.message.role !== "assistant" ||
    !("content" in entry.message)
  ) {
    return undefined;
  }
  return entry.message as AssistantOutcomeMessage;
}

export function getStructuredOutputEntry(entry: SessionEntry): StructuredOutputEntry | undefined {
  if (entry.type !== "custom" || entry.customType !== SUBAGENT_STRUCTURED_OUTPUT_ENTRY) {
    return undefined;
  }
  const parsed = parseSubagentStructuredOutputEntry(entry.data);
  if (!parsed) {
    return undefined;
  }
  if (parsed.status === "captured") {
    return { structured: parsed.structured };
  }
  if (parsed.status === "error" && parsed.error) {
    return { error: parsed.error };
  }
  return undefined;
}
