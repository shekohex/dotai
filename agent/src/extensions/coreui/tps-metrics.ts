import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { CoreUITPSStats } from "./types.js";

type AssistantUsageSummary = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

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

function formatDuration(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return "0s";
  }
  const totalSeconds = elapsedMs / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const roundedSeconds = Math.round(totalSeconds);
  const days = Math.floor(roundedSeconds / 86_400);
  const hours = Math.floor((roundedSeconds % 86_400) / 3_600);
  const minutes = Math.floor((roundedSeconds % 3_600) / 60);
  const seconds = roundedSeconds % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ");
}

function calculateIntervalTPS(outputTokenDelta: number, elapsedMs: number): number | undefined {
  if (elapsedMs <= 0 || outputTokenDelta <= 0) {
    return undefined;
  }
  return roundTPS(outputTokenDelta / (elapsedMs / 1000));
}

function buildTPSStats(samples: number[]): CoreUITPSStats | undefined {
  if (samples.length === 0) {
    return undefined;
  }
  const sorted = [...samples].toSorted((left, right) => left - right);
  const middleIndex = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? roundTPS((sorted[middleIndex - 1] + sorted[middleIndex]) / 2)
      : (sorted[middleIndex] ?? 0);
  return {
    current: samples.at(-1) ?? 0,
    min: sorted[0] ?? 0,
    median,
    max: sorted.at(-1) ?? 0,
    sampleCount: samples.length,
    bufferSize: 50,
  };
}

function summarizeAssistantUsage(messages: AgentMessage[]): AssistantUsageSummary {
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

function estimateAssistantOutputTokens(message: AssistantMessage): number {
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

function resolveAssistantOutputTokens(message: AssistantMessage): number {
  const outputTokens = message.usage.output || 0;
  return outputTokens > 0 ? outputTokens : estimateAssistantOutputTokens(message);
}

export {
  buildTPSStats,
  calculateIntervalTPS,
  formatCompactCount,
  formatDuration,
  resolveAssistantOutputTokens,
  summarizeAssistantUsage,
  estimateAssistantOutputTokens,
};
export type { AssistantUsageSummary };
