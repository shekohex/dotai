import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const truthyValues = new Set(["1", "true", "yes", "on"]);

function isTruthy(value: string | undefined): boolean {
  if (!value) {
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
    (_key, current) => {
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
  if (override && override.trim().length > 0) {
    if (override.startsWith("~/")) {
      return join(process.env.HOME ?? process.cwd(), override.slice(2));
    }
    return override;
  }

  return join(process.cwd(), ".pi", "debug", "provider-requests.jsonl");
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
    mkdirSync(dirname(logPath), { recursive: true });

    const requestSystemPrompt = extractSystemPrompt(event.payload);
    const effectiveSystemPrompt = requestSystemPrompt ?? turnSystemPrompt ?? ctx.getSystemPrompt();
    const payload = isPlainObject(event.payload)
      ? {
          ...event.payload,
        }
      : event.payload;

    const record = {
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      cwd: ctx.cwd,
      beforeAgentStartSystemPrompt: turnSystemPrompt,
      requestSystemPrompt,
      effectiveSystemPrompt,
      payload,
    };

    appendFileSync(logPath, `${safeStringify(record)}\n`, "utf8");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("provider-request-debug", undefined);
    }
  });
}
