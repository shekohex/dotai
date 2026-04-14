import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { CoreUIState, CoreUITPSStats } from "./types.js";

type AssistantUsageSummary = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

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

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

function roundTPS(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatCompactCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) {
    return "?";
  }

  if (count < 1_000) {
    return `${Math.round(count)}`;
  }

  if (count < 10_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }

  if (count < 1_000_000) {
    return `${Math.round(count / 1_000)}K`;
  }

  if (count < 10_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }

  return `${Math.round(count / 1_000_000)}M`;
}

export function calculateIntervalTPS(
  outputTokenDelta: number,
  elapsedMs: number,
): number | undefined {
  if (elapsedMs <= 0 || outputTokenDelta <= 0) {
    return undefined;
  }

  return roundTPS(outputTokenDelta / (elapsedMs / 1000));
}

function calculateCumulativeTPS(
  outputTokens: number,
  startedAtMs: number,
  nowMs: number = Date.now(),
): number | undefined {
  return calculateIntervalTPS(outputTokens, nowMs - startedAtMs);
}

export function buildTPSStats(samples: number[]): CoreUITPSStats | undefined {
  if (samples.length === 0) {
    return undefined;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const middleIndex = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? roundTPS((sorted[middleIndex - 1] + sorted[middleIndex]) / 2)
      : sorted[middleIndex];

  return {
    current: samples[samples.length - 1],
    min: sorted[0],
    median,
    max: sorted[sorted.length - 1],
    sampleCount: samples.length,
    bufferSize: TPS_SAMPLE_BUFFER_SIZE,
  };
}

function pushTPSSample(samples: number[], value: number): number[] {
  const nextSamples = [...samples, value];
  if (nextSamples.length <= TPS_SAMPLE_BUFFER_SIZE) {
    return nextSamples;
  }

  return nextSamples.slice(nextSamples.length - TPS_SAMPLE_BUFFER_SIZE);
}

export function restoreTPSState(entries: SessionEntry[]): Pick<CoreUIState, "tps" | "tpsVisible"> {
  let tps: CoreUITPSStats | undefined;
  let tpsVisible = true;

  for (const entry of entries) {
    if (entry.type !== "custom") {
      continue;
    }

    if (entry.customType === TPS_ENTRY_TYPE) {
      const restored = readTPSSessionEntry(entry.data);
      if (restored) {
        tps = restored.stats;
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

  return { tps, tpsVisible };
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
  if (sampleBuffer[sampleBuffer.length - 1] !== currentTPS) {
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

  if (
    state.tps &&
    state.tps.current === nextStats.current &&
    state.tps.max === nextStats.max &&
    state.tps.median === nextStats.median &&
    state.tps.min === nextStats.min &&
    state.tps.sampleCount === nextStats.sampleCount &&
    state.tps.bufferSize === nextStats.bufferSize
  ) {
    return { changed: false, nextSamples };
  }

  state.tps = nextStats;
  return { changed: true, nextSamples };
}

function readTPSSessionEntry(value: unknown): TPSSessionEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<TPSSessionEntry>;
  if (!candidate.stats || typeof candidate.stats !== "object") {
    return undefined;
  }

  const stats = candidate.stats as Partial<CoreUITPSStats>;
  const current = typeof stats.current === "number" ? stats.current : undefined;
  const max = typeof stats.max === "number" ? stats.max : undefined;
  const median = typeof stats.median === "number" ? stats.median : undefined;
  const min = typeof stats.min === "number" ? stats.min : undefined;
  const sampleCount =
    typeof stats.sampleCount === "number" ? stats.sampleCount : TPS_SAMPLE_BUFFER_SIZE;
  const bufferSize =
    typeof stats.bufferSize === "number" ? stats.bufferSize : TPS_SAMPLE_BUFFER_SIZE;
  const elapsedMs = typeof candidate.elapsedMs === "number" ? candidate.elapsedMs : 0;
  const input = typeof candidate.input === "number" ? candidate.input : 0;
  const output = typeof candidate.output === "number" ? candidate.output : 0;
  const cacheRead = typeof candidate.cacheRead === "number" ? candidate.cacheRead : 0;
  const cacheWrite = typeof candidate.cacheWrite === "number" ? candidate.cacheWrite : 0;
  const totalTokens = typeof candidate.totalTokens === "number" ? candidate.totalTokens : 0;

  if (
    current === undefined ||
    max === undefined ||
    median === undefined ||
    min === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(max) ||
    !Number.isFinite(median) ||
    !Number.isFinite(min) ||
    !Number.isFinite(sampleCount) ||
    !Number.isFinite(bufferSize)
  ) {
    return undefined;
  }

  return {
    stats: {
      current,
      max,
      median,
      min,
      sampleCount,
      bufferSize,
    },
    elapsedMs,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
  };
}

function readTPSVisibilityEntry(value: unknown): TPSVisibilityEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<TPSVisibilityEntry>;
  if (typeof candidate.visible !== "boolean") {
    return undefined;
  }

  return { visible: candidate.visible };
}

function getLatestTPSSessionEntry(entries: SessionEntry[]): TPSSessionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== TPS_ENTRY_TYPE) {
      continue;
    }

    const restored = readTPSSessionEntry(entry.data);
    if (restored) {
      return restored;
    }
  }

  return undefined;
}

function formatTPSNotification(entry: TPSSessionEntry): string {
  const elapsedSeconds = entry.elapsedMs / 1000;
  const averageTPS = calculateIntervalTPS(entry.output, entry.elapsedMs) ?? entry.stats.current;
  return `TPS ${averageTPS.toFixed(1)} tok/s. out ${formatCompactCount(entry.output)}, in ${formatCompactCount(entry.input)}, cache r/w ${formatCompactCount(entry.cacheRead)}/${formatCompactCount(entry.cacheWrite)}, total ${formatCompactCount(entry.totalTokens)}, ${elapsedSeconds.toFixed(1)}s`;
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
  usage: AssistantUsageSummary,
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

function handleTPSCommand(
  pi: ExtensionAPI,
  state: CoreUIState,
  requestRender: () => void,
  args: string,
  ctx: ExtensionCommandContext,
): void {
  const action = args.trim().toLowerCase();

  if (!action || action === "status") {
    const latestEntry = getLatestTPSSessionEntry(ctx.sessionManager.getBranch());
    const status = `TPS ${state.tpsVisible ? "on" : "off"}`;
    ctx.ui.notify(
      latestEntry ? `${status}. ${formatTPSNotification(latestEntry)}` : status,
      "info",
    );
    return;
  }

  if (action !== "on" && action !== "off") {
    ctx.ui.notify("Usage: /tps <on|off>", "warning");
    return;
  }

  const visible = action === "on";
  const changed = setPersistedTPSVisibility(pi, state, visible);
  if (changed) {
    requestRender();
  }

  ctx.ui.notify(`TPS ${visible ? "enabled" : "hidden"}`, "info");
}

export function summarizeAssistantUsage(messages: AgentMessage[]): AssistantUsageSummary {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;

  for (const message of messages) {
    if (!isAssistantMessage(message)) continue;
    input += message.usage.input || 0;
    output += message.usage.output || 0;
    cacheRead += message.usage.cacheRead || 0;
    cacheWrite += message.usage.cacheWrite || 0;
    totalTokens += message.usage.totalTokens || 0;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
  };
}

export function estimateAssistantOutputTokens(message: AssistantMessage): number {
  let characters = 0;

  for (const block of message.content) {
    if (block.type === "text") {
      characters += block.text.length;
      continue;
    }

    if (block.type === "thinking") {
      characters += block.thinking.length;
      continue;
    }

    if (block.type === "toolCall") {
      characters += block.name.length + JSON.stringify(block.arguments).length;
    }
  }

  if (characters <= 0) {
    return 0;
  }

  return Math.max(1, Math.round(characters / 4));
}

export function resolveAssistantOutputTokens(message: AssistantMessage): number {
  const outputTokens = message.usage.output || 0;
  return outputTokens > 0 ? outputTokens : estimateAssistantOutputTokens(message);
}

export default function registerTPSExtension(
  pi: ExtensionAPI,
  state: CoreUIState,
  requestRender: () => void,
) {
  let run: TPSRunState | null = null;
  let sessionSamples: number[] = [];

  pi.registerCommand("tps", {
    description: "Toggle TPS footer display: /tps on, /tps off",
    getArgumentCompletions: (prefix) => getTPSCommandCompletions(prefix),
    handler: async (args, ctx) => {
      handleTPSCommand(pi, state, requestRender, args, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const restored = restoreTPSState(ctx.sessionManager.getBranch());
    state.tps = restored.tps;
    state.tpsVisible = restored.tpsVisible;
    sessionSamples = [];
    requestRender();
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    const now = Date.now();

    run = {
      startedAtMs: now,
      completedOutputTokens: 0,
      currentOutputTokens: 0,
    };
  });

  pi.on("message_update", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!run) return;
    if (!isAssistantMessage(event.message)) return;

    run.currentOutputTokens = resolveAssistantOutputTokens(event.message);

    const result = setTPSState(
      state,
      sessionSamples,
      run,
      run.completedOutputTokens + run.currentOutputTokens,
    );
    sessionSamples = result.nextSamples;
    if (result.changed) {
      requestRender();
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!run) return;
    if (!isAssistantMessage(event.message)) return;

    run.completedOutputTokens += resolveAssistantOutputTokens(event.message);
    run.currentOutputTokens = 0;

    const result = setTPSState(state, sessionSamples, run, run.completedOutputTokens);
    sessionSamples = result.nextSamples;
    if (result.changed) {
      requestRender();
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (!run) return;

    const result = setTPSState(
      state,
      sessionSamples,
      run,
      run.completedOutputTokens + run.currentOutputTokens,
    );
    sessionSamples = result.nextSamples;
    if (result.changed) {
      requestRender();
    }
  });

  pi.on("agent_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!run) return;

    const elapsedMs = Date.now() - run.startedAtMs;
    const usage = summarizeAssistantUsage(event.messages);
    const outputTokens = Math.max(
      usage.output,
      run.completedOutputTokens + run.currentOutputTokens,
    );

    const result = setTPSState(state, sessionSamples, run, outputTokens);
    sessionSamples = result.nextSamples;
    const didChange = result.changed;
    const finalStats = state.tps;

    run = null;

    if (didChange) {
      requestRender();
    }

    if (elapsedMs > 0 && usage.output > 0 && finalStats) {
      appendTPSEntry(pi, finalStats, usage, elapsedMs);
    }

    if (!state.tpsVisible || elapsedMs <= 0 || usage.output <= 0) return;

    const elapsedSeconds = elapsedMs / 1000;
    const tokensPerSecond = usage.output / elapsedSeconds;
    const message = `TPS ${tokensPerSecond.toFixed(1)} tok/s. out ${formatCompactCount(usage.output)}, in ${formatCompactCount(usage.input)}, cache r/w ${formatCompactCount(usage.cacheRead)}/${formatCompactCount(usage.cacheWrite)}, total ${formatCompactCount(usage.totalTokens)}, ${elapsedSeconds.toFixed(1)}s`;
    ctx.ui.notify(message, "info");
  });
}
