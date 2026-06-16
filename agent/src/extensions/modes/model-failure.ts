export type ModelFailureKind =
  | "abort"
  | "auth"
  | "billing"
  | "content_filter"
  | "context_overflow"
  | "rate_limit"
  | "temporary_quota"
  | "unavailable"
  | "unknown";

export type ModelFailureClassification = {
  kind: ModelFailureKind;
  retryAfterMs?: number;
};

const MIN_DELAY_MS = 250;
const DEFAULT_RATE_LIMIT_DELAY_MS = 2 * 60_000;
const DEFAULT_UNAVAILABLE_DELAY_MS = 30_000;

export function classifyModelFailure(message: string): ModelFailureClassification {
  const normalized = message.toLowerCase();
  const retryAfterMs = parseRetryAfterMs(message);

  if (isAbortError(normalized)) return { kind: "abort" };
  if (isContextOverflowError(normalized)) return { kind: "context_overflow" };
  if (isContentFilterError(normalized)) return { kind: "content_filter" };
  if (isAuthError(normalized)) return { kind: "auth" };
  if (isBillingError(normalized)) return { kind: "billing" };
  if (isRateLimitError(normalized)) {
    return { kind: retryAfterMs === undefined ? "rate_limit" : "temporary_quota", retryAfterMs };
  }
  if (isUnavailableError(normalized)) return { kind: "unavailable", retryAfterMs };

  return { kind: "unknown", retryAfterMs };
}

export function cooldownDelayMs(classification: ModelFailureClassification): number {
  if (classification.retryAfterMs !== undefined) {
    return Math.max(MIN_DELAY_MS, classification.retryAfterMs);
  }
  if (classification.kind === "unavailable") return DEFAULT_UNAVAILABLE_DELAY_MS;
  return DEFAULT_RATE_LIMIT_DELAY_MS;
}

export function shouldFallbackImmediately(classification: ModelFailureClassification): boolean {
  return (
    classification.kind === "rate_limit" ||
    classification.kind === "temporary_quota" ||
    classification.kind === "billing"
  );
}

export function isUnavailableFailure(classification: ModelFailureClassification): boolean {
  return classification.kind === "unavailable";
}

function parseRetryAfterMs(message: string): number | undefined {
  const durationMatch =
    /(?:retryDelay|quotaResetDelay|retry after|quota will reset after|try again in ~?)[^0-9]*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|min|mins|minute|minutes)?/i.exec(
      message,
    );
  if (durationMatch !== null) {
    const value = Number(durationMatch[1]);
    const unit = durationMatch[2]?.toLowerCase();
    if (!Number.isFinite(value)) return undefined;
    if (unit === "ms") return value;
    if (unit?.startsWith("min")) return value * 60_000;
    return value * 1000;
  }

  const timestampMatch = /quotaResetTimeStamp[^0-9]*(\d{4}-\d{2}-\d{2}T[^\s"}]+)/i.exec(message);
  if (timestampMatch !== null) {
    const timestampMs = Date.parse(timestampMatch[1] ?? "");
    if (Number.isFinite(timestampMs)) return Math.max(0, timestampMs - Date.now());
  }

  return undefined;
}

function isAbortError(message: string): boolean {
  return message.includes("aborted") || message.includes("request was aborted");
}

function isContextOverflowError(message: string): boolean {
  return /context.?length|context.?window|too many tokens|maximum context|input.?too.?long/u.test(
    message,
  );
}

function isContentFilterError(message: string): boolean {
  return message.includes("content_filter") || message.includes("safety filter");
}

function isAuthError(message: string): boolean {
  return /authentication|unauthorized|invalid api key|expired credential|no api key/u.test(message);
}

function isBillingError(message: string): boolean {
  return /gousagelimiterror|freeusagelimiterror|billing|insufficient_quota|available balance|out of budget|monthly usage limit reached|quota exceeded/u.test(
    message,
  );
}

function isRateLimitError(message: string): boolean {
  return (
    /\b429\b/u.test(message) ||
    message.includes("rate_limit") ||
    message.includes("ratelimit") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("resource_exhausted") ||
    message.includes("retryinfo") ||
    message.includes("quota will reset") ||
    message.includes("quotareset") ||
    message.includes("usage_limit_reached") ||
    message.includes("usage_not_included") ||
    message.includes("rate_limit_exceeded") ||
    message.includes("usage limit")
  );
}

function isUnavailableError(message: string): boolean {
  return (
    /overloaded|provider.?returned.?error|\b500\b|\b502\b|\b503\b|\b504\b|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|websocket transport is not available|other side closed|fetch failed|request failed|failed after retries|no response body|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|stream closed before response\.completed|http2 request did not get a response|invalid codex sse json|invalid codex websocket json|timed? out|timeout|terminated/u.test(
      message,
    ) ||
    /error occurred while processing your request|you can retry your request|help\.openai\.com/u.test(
      message,
    )
  );
}
