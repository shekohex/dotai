const STALE_SESSION_REPLACEMENT_ERROR_FRAGMENT = "stale after session replacement or reload";

export function isStaleSessionReplacementContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(STALE_SESSION_REPLACEMENT_ERROR_FRAGMENT);
}
