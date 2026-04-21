const DEFAULT_CURSOR_EPOCH = new Date("2024-10-09T00:00:00.000Z");
const DEFAULT_CURSOR_INTERVAL_SECONDS = 20;
const MIN_JITTER_SECONDS = 1;
const MAX_JITTER_SECONDS = 3600;

function calculateCursor(nowMs: number): string {
  const epochMs = DEFAULT_CURSOR_EPOCH.getTime();
  const intervalMs = DEFAULT_CURSOR_INTERVAL_SECONDS * 1000;
  return String(Math.floor((nowMs - epochMs) / intervalMs));
}

function generateJitterIntervals(): number {
  const jitterSeconds =
    MIN_JITTER_SECONDS + Math.floor(Math.random() * (MAX_JITTER_SECONDS - MIN_JITTER_SECONDS + 1));
  return Math.max(1, Math.ceil(jitterSeconds / DEFAULT_CURSOR_INTERVAL_SECONDS));
}

export function generateResponseCursor(
  clientCursor: string | undefined,
  nowMs = Date.now(),
): string {
  const currentCursor = calculateCursor(nowMs);
  if (clientCursor === undefined || clientCursor.length === 0) {
    return currentCursor;
  }
  const currentInterval = Number.parseInt(currentCursor, 10);
  const clientInterval = Number.parseInt(clientCursor, 10);
  if (Number.isNaN(clientInterval) || clientInterval < currentInterval) {
    return currentCursor;
  }
  return String(clientInterval + generateJitterIntervals());
}
