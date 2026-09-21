import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { debugLog } from "../debug-log.js";

/** Default cooldown applied to a model after a rate-limit/overload stream failure. */
export const WORKER_MODEL_COOLDOWN_MS = 60_000;

/**
 * Surface LLM failures from an agent-loop event stream.
 *
 * When the underlying LLM call fails, the loop ends the stream with a final assistant message whose
 * stopReason is "error" (or "aborted") — no exception is thrown. Without this hook the drain loops
 * treat such runs exactly like "the model chose not to call the tool", which hides the real cause
 * (rate limits, oversized prompts, auth failures, ...) from the debug log.
 */
export type StreamFailure = { stopReason: string; errorMessage?: string };

/** Minimal structural shape of an agent-loop event stream handed to workers. */
export type WorkerEventStream = AsyncIterable<AgentEvent> & { result: () => Promise<unknown> };

/**
 * Base class for terminal API/stream failures surfaced by the background workers.
 *
 * Agent-core returns failed runs normally, so without throwing, callers cannot tell a hard failure
 * from a deliberate empty result (#32). Callers catch this base class to advance through the
 * configured fallback-model chain and cool down rate-limited models.
 */
export class WorkerStreamError extends Error {
  readonly stopReason: string;
  readonly workerErrorMessage: string | undefined;
  constructor(stage: string, stopReason: string, errorMessage?: string) {
    const suffix = errorMessage !== undefined && errorMessage.length > 0 ? `: ${errorMessage}` : "";
    super(`${stage} stream ended with stopReason "${stopReason}"${suffix}`);
    this.name = "WorkerStreamError";
    this.stopReason = stopReason;
    this.workerErrorMessage = errorMessage;
  }
}

const RATE_LIMIT_PATTERN =
  /overloaded|high demand|rate.?limit|too many requests|429|retry.?delay|please retry/i;
const NON_RATE_LIMIT_QUOTA_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

/**
 * Parse a provider retry hint ("try again in 12s", "retry after 30 seconds") from an error message.
 *
 * @param {string | undefined} errorMessage Raw provider error text.
 * @returns {number | undefined} Hinted cooldown in ms, when a usable hint is present.
 */
export function parseRetryAfterMs(errorMessage: string | undefined): number | undefined {
  if (errorMessage === undefined) return undefined;
  const patterns = [
    /retry[- ]?after[:\s]*(\d{1,4})\s*(?:s\b|sec|seconds?)/i,
    /(?:try again|wait)[^.\d]{0,40}(\d{1,4})\s*(?:s\b|sec|seconds?)/i,
    /\bin\s+(\d{1,4})\s*(?:s\b|sec|seconds?)/i,
  ];
  for (const pattern of patterns) {
    const match = errorMessage.match(pattern);
    if (match !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) return value * 1000;
    }
  }
  return undefined;
}

/**
 * Classify a stream failure as a transient rate-limit/overload (cooldown-worthy) versus other
 * failures (quota exhaustion, auth, network). Mirrors the house split used by pi-ai's retry helper:
 * subscription/billing exhaustion is NOT transient and must not cool a model down.
 *
 * @param {StreamFailure} failure Terminal stream failure descriptor.
 * @returns {boolean} Whether the failure looks like a transient rate limit or overload.
 */
export function isRateLimitedStreamFailure(failure: StreamFailure): boolean {
  if (failure.stopReason === "aborted") return false;
  const message = failure.errorMessage ?? "";
  if (NON_RATE_LIMIT_QUOTA_PATTERN.test(message)) return false;
  return RATE_LIMIT_PATTERN.test(message);
}

/**
 * Extract a terminal API/stream failure from a loop event, if any.
 *
 * @param {AgentEvent} event Loop event to inspect.
 * @returns {StreamFailure | undefined} Failure descriptor for error/aborted assistant messages.
 */
export function streamFailureFromEvent(event: AgentEvent): StreamFailure | undefined {
  if (event.type !== "message_end") return undefined;
  const message = event.message;
  if (message.role !== "assistant") return undefined;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
  return { stopReason: message.stopReason, errorMessage: message.errorMessage };
}

/**
 * Drain a worker's agent-loop event stream: log terminal API/stream failures and return the last
 * one, if any. Awaited `stream.result()` propagates loop-level errors exactly like the inline drain
 * loops it replaces.
 *
 * @param {"observer" | "reflector" | "dropper"} stage Worker stage label for log lines.
 * @param {WorkerEventStream} stream Agent-loop event stream.
 * @returns {Promise<StreamFailure | undefined>} Terminal stream failure, when one occurred.
 */
export async function drainWorkerStream(
  stage: "observer" | "reflector" | "dropper",
  stream: WorkerEventStream,
): Promise<StreamFailure | undefined> {
  let failure: StreamFailure | undefined;
  for await (const event of stream) {
    logAgentStreamError(stage, event);
    const next = streamFailureFromEvent(event);
    if (next !== undefined) failure = next;
  }
  await stream.result();
  return failure;
}

/**
 * Surface LLM failures from an agent-loop event stream.
 *
 * When the underlying LLM call fails, the loop ends the stream with a final assistant message whose
 * stopReason is "error" (or "aborted") — no exception is thrown. Without this hook the drain loops
 * treat such runs exactly like "the model chose not to call the tool", which hides the real cause
 * (rate limits, oversized prompts, auth failures, ...) from the debug log.
 *
 * @param {"observer" | "reflector" | "dropper"} stage Worker stage label.
 * @param {AgentEvent} event Loop event to log.
 * @returns {void}
 */
export function logAgentStreamError(
  stage: "observer" | "reflector" | "dropper",
  event: AgentEvent,
): void {
  if (event.type !== "message_end") return;
  const message = event.message;
  if (message.role !== "assistant") return;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return;
  debugLog(`${stage}.stream_error`, {
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
  });
}
