import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CoreUIState, CoreUITPSStats } from "./types.js";
import { buildTPSStats, calculateIntervalTPS, formatCompactCount } from "./tps-metrics.js";

type TPSRunState = {
  startedAtMs: number;
  completedOutputTokens: number;
  currentOutputTokens: number;
};

type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];

type TPSSessionEntry = {
  stats: CoreUITPSStats;
  elapsedMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

type TPSVisibilityEntry = {
  visible: boolean;
};

const TPS_ENTRY_TYPE = "coreui:tps";
const TPS_VISIBILITY_ENTRY_TYPE = "coreui:tps-visibility";
const TPS_COMMAND_COMPLETIONS = ["on", "off", "status"] as const;
const TPS_SAMPLE_BUFFER_SIZE = 50;

function pushTPSSample(samples: number[], value: number): number[] {
  const nextSamples = [...samples, value];
  if (nextSamples.length <= TPS_SAMPLE_BUFFER_SIZE) {
    return nextSamples;
  }
  return nextSamples.slice(nextSamples.length - TPS_SAMPLE_BUFFER_SIZE);
}

function calculateCumulativeTPS(
  outputTokens: number,
  startedAtMs: number,
  nowMs: number = Date.now(),
): number | undefined {
  return calculateIntervalTPS(outputTokens, nowMs - startedAtMs);
}

function restoreTPSState(
  entries: SessionEntry[],
): Pick<CoreUIState, "tps" | "tpsVisible" | "tpsElapsedMs"> {
  let tps: CoreUITPSStats | undefined;
  let tpsVisible = true;
  let tpsElapsedMs = 0;
  for (const entry of entries) {
    if (entry.type !== "custom") {
      continue;
    }
    if (entry.customType === TPS_ENTRY_TYPE) {
      const restored = readTPSSessionEntry(entry.data);
      if (restored) {
        tps = restored.stats;
        if (restored.elapsedMs > 0 && Number.isFinite(restored.elapsedMs)) {
          tpsElapsedMs += restored.elapsedMs;
        }
      }
      continue;
    }
    if (entry.customType === TPS_VISIBILITY_ENTRY_TYPE) {
      const restored = readTPSVisibilityEntry(entry.data);
      if (restored) {
        tpsVisible = restored.visible;
      }
    }
  }
  return { tps, tpsVisible, tpsElapsedMs };
}

function updateTPSElapsedInState(
  state: CoreUIState,
  persistedElapsedMs: number,
  run: TPSRunState | null,
  nowMs: number = Date.now(),
): boolean {
  const runElapsedMs = run ? Math.max(0, nowMs - run.startedAtMs) : 0;
  const nextElapsedMs = persistedElapsedMs + runElapsedMs;
  if (state.tpsElapsedMs === nextElapsedMs) {
    return false;
  }
  state.tpsElapsedMs = nextElapsedMs;
  return true;
}

function setTPSState(
  state: CoreUIState,
  sampleBuffer: number[],
  run: TPSRunState,
  outputTokens: number,
  nowMs: number = Date.now(),
): { changed: boolean; nextSamples: number[] } {
  const currentTPS = calculateCumulativeTPS(outputTokens, run.startedAtMs, nowMs);
  if (currentTPS === undefined) {
    return { changed: false, nextSamples: sampleBuffer };
  }
  let nextSamples = sampleBuffer;
  if (sampleBuffer.at(-1) !== currentTPS) {
    nextSamples = pushTPSSample(sampleBuffer, currentTPS);
  }
  const aggregateStats = buildTPSStats(nextSamples);
  if (!aggregateStats) {
    if (state.tps === undefined) {
      return { changed: false, nextSamples };
    }
    state.tps = undefined;
    return { changed: true, nextSamples };
  }
  const nextStats: CoreUITPSStats = {
    current: currentTPS,
    max: aggregateStats.max,
    median: aggregateStats.median,
    min: aggregateStats.min,
    sampleCount: aggregateStats.sampleCount,
    bufferSize: aggregateStats.bufferSize,
  };
  if (hasSameTPSStats(state.tps, nextStats)) {
    return { changed: false, nextSamples };
  }
  state.tps = nextStats;
  return { changed: true, nextSamples };
}

function hasSameTPSStats(current: CoreUITPSStats | undefined, next: CoreUITPSStats): boolean {
  return (
    current !== undefined &&
    current.current === next.current &&
    current.max === next.max &&
    current.median === next.median &&
    current.min === next.min &&
    current.sampleCount === next.sampleCount &&
    current.bufferSize === next.bufferSize
  );
}

function readTPSSessionEntry(value: unknown): TPSSessionEntry | undefined {
  if (value === undefined || value === null || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Partial<TPSSessionEntry>;
  if (!candidate.stats || typeof candidate.stats !== "object") {
    return undefined;
  }
  const stats = parseTPSStats(candidate.stats as Partial<CoreUITPSStats>);
  if (!stats) {
    return undefined;
  }
  const elapsedMs = readNumber(candidate.elapsedMs, 0);
  return {
    stats,
    elapsedMs,
    input: readNumber(candidate.input, 0),
    output: readNumber(candidate.output, 0),
    cacheRead: readNumber(candidate.cacheRead, 0),
    cacheWrite: readNumber(candidate.cacheWrite, 0),
    totalTokens: readNumber(candidate.totalTokens, 0),
  };
}

function parseTPSStats(stats: Partial<CoreUITPSStats>): CoreUITPSStats | undefined {
  const current = readRequiredNumber(stats.current);
  const min = readRequiredNumber(stats.min);
  const median = readRequiredNumber(stats.median);
  const max = readRequiredNumber(stats.max);
  if (current === undefined || min === undefined || median === undefined || max === undefined) {
    return undefined;
  }
  return {
    current,
    min,
    median,
    max,
    sampleCount: readNumber(stats.sampleCount, 1),
    bufferSize: readNumber(stats.bufferSize, TPS_SAMPLE_BUFFER_SIZE),
  };
}

function readRequiredNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readTPSVisibilityEntry(value: unknown): TPSVisibilityEntry | undefined {
  if (value === undefined || value === null || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Partial<TPSVisibilityEntry>;
  if (typeof candidate.visible !== "boolean") {
    return undefined;
  }
  return { visible: candidate.visible };
}

function getLatestTPSSessionEntry(entries: SessionEntry[]): TPSSessionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== TPS_ENTRY_TYPE) {
      continue;
    }
    const parsed = readTPSSessionEntry(entry.data);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function formatTPSNotification(entry: TPSSessionEntry): string {
  const averageTPS = calculateIntervalTPS(entry.output, entry.elapsedMs) ?? entry.stats.current;
  return `TPS: ${entry.stats.current.toFixed(1)} tok/s (avg ${averageTPS.toFixed(1)} tok/s, ${formatCompactCount(entry.totalTokens)} total)`;
}

function setTPSVisibility(state: CoreUIState, visible: boolean): boolean {
  if (state.tpsVisible === visible) {
    return false;
  }
  state.tpsVisible = visible;
  return true;
}

function appendTPSEntry(
  pi: ExtensionAPI,
  stats: CoreUITPSStats,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  },
  elapsedMs: number,
): void {
  pi.appendEntry<TPSSessionEntry>(TPS_ENTRY_TYPE, {
    stats,
    elapsedMs,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  });
}

function setPersistedTPSVisibility(
  pi: ExtensionAPI,
  state: CoreUIState,
  visible: boolean,
): boolean {
  const changed = setTPSVisibility(state, visible);
  if (!changed) {
    return false;
  }
  pi.appendEntry<TPSVisibilityEntry>(TPS_VISIBILITY_ENTRY_TYPE, { visible });
  return true;
}

function getTPSCommandCompletions(argumentPrefix: string) {
  const prefix = argumentPrefix.trim().toLowerCase();
  const items = TPS_COMMAND_COMPLETIONS.filter((value) => value.startsWith(prefix)).map(
    (value) => ({ value, label: value }),
  );
  return items.length > 0 ? items : null;
}

export {
  appendTPSEntry,
  formatTPSNotification,
  getLatestTPSSessionEntry,
  getTPSCommandCompletions,
  restoreTPSState,
  setPersistedTPSVisibility,
  setTPSState,
  setTPSVisibility,
  updateTPSElapsedInState,
};
export type { TPSRunState };
