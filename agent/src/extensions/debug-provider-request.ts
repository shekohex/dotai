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

function extractSystemPrompt(payload: unknown): string | undefined {
  const candidateKeys = new Set([
    "systemPrompt",
    "systemInstruction",
    "instructions",
    "instruction",
    "system",
  ]);
  const visited = new WeakSet<object>();
  const queue: unknown[] = [payload];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!isPlainObject(current)) {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    for (const [key, value] of Object.entries(current)) {
      if (candidateKeys.has(key) && typeof value === "string" && value.trim().length > 0) {
        return value;
      }

      if (typeof value === "object" && value !== null) {
        queue.push(value);
      }
    }
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

function buildProviderRequestRecord(input: {
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
