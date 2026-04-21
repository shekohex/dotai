import type { MeasurementMode, RangeAgg, RGB } from "./types.js";
import { DOW_NAMES, TOD_BUCKETS } from "./types.js";
import { dowMetricForRange, graphMetricForRange } from "./metrics.js";
import {
  EMPTY_CELL_BG,
  abbreviatePath,
  ansiFg,
  dim,
  formatCount,
  formatUsd,
  padLeft,
  padRight,
} from "./utils.js";

export function displayModelName(modelKey: string): string {
  const idx = modelKey.indexOf("/");
  return idx === -1 ? modelKey : modelKey.slice(idx + 1);
}

export function renderModelTable(range: RangeAgg, mode: MeasurementMode, maxRows = 8): string[] {
  const metric = graphMetricForRange(range, mode);
  const kind = metric.kind;
  let perModel = range.modelSessions;
  let total = range.sessions;
  if (kind === "tokens") {
    perModel = range.modelTokens;
    total = range.totalTokens;
  } else if (kind === "messages") {
    perModel = range.modelMessages;
    total = range.totalMessages;
  }

  const sorted = [...perModel.entries()]
    .map(([key, value]) => ({ key, value }))
    .toSorted((a, b) => b.value - a.value);
  const rows = sorted.slice(0, maxRows);
  const valueWidth = kind === "tokens" ? 10 : 8;
  const modelWidth = Math.min(52, Math.max("model".length, ...rows.map((r) => r.key.length)));

  const lines: string[] = [
    `${padRight("model", modelWidth)}  ${padLeft(kind, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`,
    `${"-".repeat(modelWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`,
  ];

  for (const r of rows) {
    const value = perModel.get(r.key) ?? 0;
    const cost = range.modelCost.get(r.key) ?? 0;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    lines.push(
      `${padRight(r.key.slice(0, modelWidth), modelWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
    );
  }

  if (sorted.length === 0) {
    lines.push(dim("(no model data found)"));
  }

  return lines;
}

export function renderCwdTable(range: RangeAgg, mode: MeasurementMode, maxRows = 8): string[] {
  const metric = graphMetricForRange(range, mode);
  const kind = metric.kind;
  let perCwd = range.cwdSessions;
  let total = range.sessions;
  if (kind === "tokens") {
    perCwd = range.cwdTokens;
    total = range.totalTokens;
  } else if (kind === "messages") {
    perCwd = range.cwdMessages;
    total = range.totalMessages;
  }

  const sorted = [...perCwd.entries()]
    .map(([key, value]) => ({ key, value }))
    .toSorted((a, b) => b.value - a.value);
  const rows = sorted.slice(0, maxRows);
  const valueWidth = kind === "tokens" ? 10 : 8;
  const displayPaths = rows.map((r) => abbreviatePath(r.key, 40));
  const cwdWidth = Math.min(42, Math.max("directory".length, ...displayPaths.map((p) => p.length)));

  const lines: string[] = [
    `${padRight("directory", cwdWidth)}  ${padLeft(kind, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`,
    `${"-".repeat(cwdWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`,
  ];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const value = perCwd.get(r.key) ?? 0;
    const cost = range.cwdCost.get(r.key) ?? 0;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    lines.push(
      `${padRight(displayPaths[i].slice(0, cwdWidth), cwdWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
    );
  }

  if (sorted.length === 0) {
    lines.push(dim("(no directory data found)"));
  }

  return lines;
}

export function renderDowDistributionLines(
  range: RangeAgg,
  mode: MeasurementMode,
  dowColors: Map<string, RGB>,
  width: number,
): string[] {
  const { kind, perDow, total } = dowMetricForRange(range, mode);
  const dayWidth = 3;
  const pctWidth = 4;
  const valueWidth = kind === "tokens" ? 10 : 8;
  const showValue = width >= dayWidth + 1 + 10 + 1 + pctWidth + 1 + valueWidth;
  const fixedWidth = dayWidth + 1 + 1 + pctWidth + (showValue ? 1 + valueWidth : 0);
  const barWidth = Math.max(1, width - fixedWidth);
  const fallbackColor: RGB = { r: 160, g: 160, b: 160 };

  const lines: string[] = [];
  for (const dow of DOW_NAMES) {
    const value = perDow.get(dow) ?? 0;
    const share = total > 0 ? value / total : 0;
    let filled = share > 0 ? Math.round(share * barWidth) : 0;
    if (share > 0) filled = Math.max(1, filled);
    filled = Math.min(barWidth, filled);
    const empty = Math.max(0, barWidth - filled);

    const color = dowColors.get(dow) ?? fallbackColor;
    const filledBar = filled > 0 ? ansiFg(color, "█".repeat(filled)) : "";
    const emptyBar = empty > 0 ? ansiFg(EMPTY_CELL_BG, "█".repeat(empty)) : "";
    const pct = padLeft(`${Math.round(share * 100)}%`, pctWidth);

    let line = `${padRight(dow, dayWidth)} ${filledBar}${emptyBar} ${pct}`;
    if (showValue) line += ` ${padLeft(formatCount(value), valueWidth)}`;
    lines.push(line);
  }

  return lines;
}

export function renderDowTable(range: RangeAgg, mode: MeasurementMode): string[] {
  const { kind, perDow, total } = dowMetricForRange(range, mode);
  const valueWidth = kind === "tokens" ? 10 : 8;
  const dowWidth = 5;
  const lines: string[] = [
    `${padRight("day", dowWidth)}  ${padLeft(kind, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`,
    `${"-".repeat(dowWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`,
  ];

  for (const dow of DOW_NAMES) {
    const value = perDow.get(dow) ?? 0;
    const cost = range.dowCost.get(dow) ?? 0;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    lines.push(
      `${padRight(dow, dowWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
    );
  }

  return lines;
}

export function renderTodTable(range: RangeAgg, mode: MeasurementMode): string[] {
  const metric = graphMetricForRange(range, mode);
  const kind = metric.kind;
  let perTod = range.todSessions;
  let total = range.sessions;
  if (kind === "tokens") {
    perTod = range.todTokens;
    total = range.totalTokens;
  } else if (kind === "messages") {
    perTod = range.todMessages;
    total = range.totalMessages;
  }
  const valueWidth = kind === "tokens" ? 10 : 8;
  const todWidth = 22;

  const lines: string[] = [
    `${padRight("time of day", todWidth)}  ${padLeft(kind, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`,
    `${"-".repeat(todWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`,
  ];

  for (const b of TOD_BUCKETS) {
    const value = perTod.get(b.key) ?? 0;
    const cost = range.todCost.get(b.key) ?? 0;
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
    lines.push(
      `${padRight(b.label, todWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
    );
  }

  return lines;
}
