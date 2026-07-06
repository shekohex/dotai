import { errorMessage } from "../utils/error-message.js";

export const GITHUB_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;

export function isRateLimitError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("secondary rate") ||
    message.includes("abuse detection")
  );
}
