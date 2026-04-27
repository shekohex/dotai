import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const truthyValues = new Set(["1", "true", "yes", "on"]);

function isTruthy(value: string | undefined): boolean {
  if (value === undefined || value.length === 0) {
    return false;
  }
  return truthyValues.has(value.trim().toLowerCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, current: unknown) => {
      if (typeof current === "bigint") {
        return current.toString();
      }
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) {
          return "[Circular]";
        }
        seen.add(current);
      }
      return current;
    },
    2,
  );
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function extractStringContentFromInputParts(value: unknown): string | undefined {
  if (typeof value === "string") {
    return readTrimmedString(value);
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const textParts = value.flatMap((part) => {
    if (!isPlainObject(part)) {
      return [];
    }

    const partType = readTrimmedString(part.type);
    if (partType !== "input_text" && partType !== "text") {
      return [];
    }

    const textPart = readTrimmedString(part.text);
    return textPart === undefined ? [] : [textPart];
  });

  return textParts.length > 0 ? textParts.join("\n\n") : undefined;
}

function extractSystemPrompt(payload: unknown): string | undefined {
  if (!isPlainObject(payload)) {
    return undefined;
  }

  const directCandidateKeys = [
    "systemPrompt",
    "systemInstruction",
    "instructions",
    "instruction",
    "system",
  ] as const;

  for (const key of directCandidateKeys) {
    const directValue = readTrimmedString(payload[key]);
    if (directValue !== undefined) {
      return directValue;
    }

    if (key === "system") {
      const systemList = payload[key];
      if (isStringArray(systemList) && systemList.length > 0) {
        return systemList.join("\n\n");
      }
    }
  }

  const input = payload.input;
  if (!Array.isArray(input)) {
    return undefined;
  }

  for (const message of input) {
    if (!isPlainObject(message)) {
      continue;
    }

    const role = readTrimmedString(message.role);
    if (role !== "developer" && role !== "system") {
      continue;
    }

    return extractStringContentFromInputParts(message.content);
  }

  return undefined;
}

function getLogPath(): string {
  const override = process.env.PI_DEBUG_PROVIDER_REQUESTS_LOG;
  if (override !== undefined && override.trim().length > 0) {
    if (override.startsWith("~/")) {
      return join(process.env.HOME ?? process.cwd(), override.slice(2));
    }
    return override;
  }

  return join(process.cwd(), ".pi", "debug", "provider-requests.jsonl");
}

export function buildProviderRequestRecord(input: {
  payload: unknown;
  turnSystemPrompt: string | undefined;
  ctx: ExtensionContext;
}): {
  timestamp: string;
  sessionId: string;
  sessionFile: string | undefined;
  model: string | undefined;
  cwd: string;
  beforeAgentStartSystemPrompt: string | undefined;
  requestSystemPrompt: string | undefined;
  effectiveSystemPrompt: string | undefined;
  payload: unknown;
} {
  const requestSystemPrompt = extractSystemPrompt(input.payload);
  const effectiveSystemPrompt =
    requestSystemPrompt ?? input.turnSystemPrompt ?? input.ctx.getSystemPrompt();
  const payload = isPlainObject(input.payload)
    ? {
        ...input.payload,
      }
    : input.payload;

  return {
    timestamp: new Date().toISOString(),
    sessionId: input.ctx.sessionManager.getSessionId(),
    sessionFile: input.ctx.sessionManager.getSessionFile(),
    model: input.ctx.model ? `${input.ctx.model.provider}/${input.ctx.model.id}` : undefined,
    cwd: input.ctx.cwd,
    beforeAgentStartSystemPrompt: input.turnSystemPrompt,
    requestSystemPrompt,
    effectiveSystemPrompt,
    payload,
  };
}

function appendProviderRequestRecord(logPath: string, record: unknown): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${safeStringify(record)}\n`, "utf8");
}

export default function debugProviderRequestExtension(pi: ExtensionAPI) {
  const enabled =
    isTruthy(process.env.PI_DEBUG_PROVIDER_REQUESTS) ||
    isTruthy(process.env.PI_DEBUG_SYSTEM_PROMPT);
  if (!enabled) {
    return;
  }

  const logPath = getLogPath();
  let turnSystemPrompt: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("provider-request-debug", `Logging provider requests to ${logPath}`);
    }
  });

  pi.on("before_agent_start", (event) => {
    turnSystemPrompt = event.systemPrompt;
  });

  pi.on("before_provider_request", (event, ctx) => {
    const record = buildProviderRequestRecord({
      payload: event.payload,
      turnSystemPrompt,
      ctx,
    });
    appendProviderRequestRecord(logPath, record);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("provider-request-debug", undefined);
    }
  });
}
