import type { DowKey, MeasurementMode, RangeAgg } from "./types.js";
import {
  addDaysLocal,
  countDaysInclusiveLocal,
  formatCount,
  formatUsd,
  localMidnight,
  mondayIndex,
} from "./utils.js";

export function graphMetricForRange(
  range: RangeAgg,
  mode: MeasurementMode,
): { kind: "sessions" | "messages" | "tokens"; max: number; denom: number } {
  if (mode === "tokens") {
    const maxTokens = Math.max(0, ...range.days.map((d) => d.tokens));
    if (maxTokens > 0) return { kind: "tokens", max: maxTokens, denom: Math.log1p(maxTokens) };
    mode = "messages";
  }

  if (mode === "messages") {
    const maxMessages = Math.max(0, ...range.days.map((d) => d.messages));
    if (maxMessages > 0)
      return { kind: "messages", max: maxMessages, denom: Math.log1p(maxMessages) };
    mode = "sessions";
  }

  const maxSessions = Math.max(0, ...range.days.map((d) => d.sessions));
  return { kind: "sessions", max: maxSessions, denom: Math.log1p(maxSessions) };
}

export function weeksForRange(range: RangeAgg): number {
  const days = range.days;
  const firstDay = days.at(0);
  const lastDay = days.at(-1);
  if (firstDay === undefined || lastDay === undefined) {
    return 0;
  }

  const start = firstDay.date;
  const end = lastDay.date;
  const gridStart = addDaysLocal(start, -mondayIndex(start));
  const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
  const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
  return Math.ceil(totalGridDays / 7);
}

export function dowMetricForRange(
  range: RangeAgg,
  mode: MeasurementMode,
): { kind: "sessions" | "messages" | "tokens"; perDow: Map<DowKey, number>; total: number } {
  const metric = graphMetricForRange(range, mode);
  const kind = metric.kind;

  if (kind === "tokens") {
    return { kind, perDow: range.dowTokens, total: range.totalTokens };
  }
  if (kind === "messages") {
    return { kind, perDow: range.dowMessages, total: range.totalMessages };
  }
  return { kind, perDow: range.dowSessions, total: range.sessions };
}

export function rangeSummary(range: RangeAgg, days: number, mode: MeasurementMode): string {
  const avg = range.sessions > 0 ? range.totalCost / range.sessions : 0;
  const costPart =
    range.totalCost > 0
      ? `${formatUsd(range.totalCost)} · avg ${formatUsd(avg)}/session`
      : `$0.0000`;

  if (mode === "tokens") {
    return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalTokens)} tokens · ${costPart}`;
  }
  if (mode === "messages") {
    return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalMessages)} messages · ${costPart}`;
  }
  return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${costPart}`;
}

export function sessionDayWithinRange(range: RangeAgg, sessionDay: Date): boolean {
  const firstDay = range.days.at(0);
  const lastDay = range.days.at(-1);
  if (firstDay === undefined || lastDay === undefined) {
    return false;
  }

  const normalizedSessionDay = localMidnight(sessionDay);
  return normalizedSessionDay >= firstDay.date && normalizedSessionDay <= lastDay.date;
}
