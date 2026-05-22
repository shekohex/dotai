import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantUsageMetric, CacheSessionMetrics } from "./types.js";
import { formatInt, formatPercent, formatTotalsLine } from "./format-utils.js";
import { computeCumulativeSeries, type CumulativeSeries } from "./cumulative.js";

export type GraphView = "per-turn" | "cumulative-percent" | "cumulative-total";

export const GRAPH_VIEWS: GraphView[] = ["per-turn", "cumulative-percent", "cumulative-total"];

export function graphViewLabel(view: GraphView): string {
  switch (view) {
    case "per-turn":
      return "Per-turn (%)";
    case "cumulative-percent":
      return "Cumulative (aggregate) %";
    case "cumulative-total":
      return "Cumulative (aggregate) total";
  }
  return view;
}

// ─── Bucketing helpers ────────────────────────────────────────────────────────

export function bucketMessages(
  messages: AssistantUsageMetric[],
  bucketCount: number,
): AssistantUsageMetric[][] {
  if (messages.length <= bucketCount) {
    return messages.map((message) => [message]);
  }
  const buckets: AssistantUsageMetric[][] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const start = Math.floor((i * messages.length) / bucketCount);
    const end = Math.floor(((i + 1) * messages.length) / bucketCount);
    buckets.push(messages.slice(start, Math.max(start + 1, end)));
  }
  return buckets;
}

/**
 * Buckets a flat numeric array using max — correct for monotonic cumulative series because max ==
 * last sample in each bucket.
 *
 * @param {number[]} values - Numeric series to bucket.
 * @param {number} bucketCount - Maximum number of buckets to return.
 * @returns {number[]} Bucketed numeric series using each bucket maximum.
 */
function bucketMax(values: number[], bucketCount: number): number[] {
  if (values.length <= bucketCount) return [...values];
  const result: number[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const start = Math.floor((i * values.length) / bucketCount);
    const end = Math.floor(((i + 1) * values.length) / bucketCount);
    const slice = values.slice(start, Math.max(start + 1, end));
    result.push(Math.max(...slice));
  }
  return result;
}

export function averageHitPercent(messages: AssistantUsageMetric[]): number {
  if (messages.length === 0) return 0;
  const total = messages.reduce((sum, message) => sum + message.cacheHitPercent, 0);
  return total / messages.length;
}

export function minHitPercent(messages: AssistantUsageMetric[]): number {
  if (messages.length === 0) return 0;
  return Math.min(...messages.map((message) => message.cacheHitPercent));
}

export function maxHitPercent(messages: AssistantUsageMetric[]): number {
  if (messages.length === 0) return 0;
  return Math.max(...messages.map((message) => message.cacheHitPercent));
}

// ─── Shared chart primitives ──────────────────────────────────────────────────

/**
 * Renders a single-series 0–100% bar chart. Label column is 4 chars + "│" = 5 chars wide.
 *
 * @param {Theme} theme - Theme used to color chart output.
 * @param {number[]} values - Percentage values to render.
 * @param {number} chartHeight - Chart height in terminal rows.
 * @returns {string[]} Rendered chart lines.
 */
function renderBarChart(theme: Theme, values: number[], chartHeight: number): string[] {
  const lines: string[] = [];
  for (let row = chartHeight; row >= 1; row -= 1) {
    const threshold = (row / chartHeight) * 100;
    const label = `${String(Math.round(threshold)).padStart(3, " ")}│`;
    const body = values
      .map((v) => (v >= threshold ? theme.fg("accent", "█") : theme.fg("dim", "·")))
      .join("");
    lines.push(theme.fg("muted", label) + body);
  }
  lines.push(theme.fg("muted", `  0│${theme.fg("dim", "─".repeat(values.length))}`));
  return lines;
}

/**
 * Renders a 3-series stacked token-volume chart. Label column is 3 chars + "k│" = 5 chars wide.
 * Priority (highest wins per cell): cacheRead > cacheWrite > input.
 *
 * @param {Theme} theme - Theme used to color chart output.
 * @param {number[]} seriesInput - Cumulative input token series.
 * @param {number[]} seriesCacheRead - Cumulative cache-read token series.
 * @param {number[]} seriesCacheWrite - Cumulative cache-write token series.
 * @param {number} chartHeight - Chart height in terminal rows.
 * @returns {{ lines: string[]; unitTokens: number }} Rendered chart lines and token scale per row.
 */
function renderStackedSeriesChart(
  theme: Theme,
  seriesInput: number[],
  seriesCacheRead: number[],
  seriesCacheWrite: number[],
  chartHeight: number,
): { lines: string[]; unitTokens: number } {
  const maxVal = Math.max(...seriesInput, ...seriesCacheRead, ...seriesCacheWrite, 1);
  let unitTokens = 5000;
  if (maxVal > chartHeight * unitTokens) {
    unitTokens = Math.ceil(maxVal / chartHeight / 5000) * 5000;
  }

  const lines: string[] = [];
  for (let row = chartHeight; row >= 1; row -= 1) {
    const threshold = row * unitTokens;
    const kVal = Math.round(threshold / 1000);
    const label = `${String(kVal).padStart(3)}k│`;
    const body = seriesInput
      .map((_, i) => {
        const inp = seriesInput[i];
        const read = seriesCacheRead[i];
        const write = seriesCacheWrite[i];
        if (read >= threshold) return theme.fg("accent", "▒");
        if (write >= threshold) return theme.fg("warning", "░");
        if (inp >= threshold) return theme.fg("muted", "▇");
        return theme.fg("dim", "·");
      })
      .join("");
    lines.push(theme.fg("muted", label) + body);
  }
  lines.push(theme.fg("muted", `    0│${theme.fg("dim", "─".repeat(seriesInput.length))}`));
  return { lines, unitTokens };
}

function xAxisFooter(
  theme: Theme,
  bucketCount: number,
  totalMessages: number,
  indent: string,
): string[] {
  const countStr = String(totalMessages);
  const spacer = bucketCount > 2 ? " ".repeat(Math.max(1, bucketCount - countStr.length - 1)) : "";
  return [
    theme.fg("dim", `${indent}1`) +
      (bucketCount > 2 ? theme.fg("dim", `${spacer}${countStr}`) : ""),
    theme.fg("dim", `${indent}assistant-message sequence in session append order`),
  ];
}

// ─── Per-view renderers ───────────────────────────────────────────────────────

function renderPerTurnPercent(
  theme: Theme,
  messages: AssistantUsageMetric[],
  chartWidth: number,
): string[] {
  const lines: string[] = [];
  const chartHeight = 10;
  const buckets = bucketMessages(messages, chartWidth);
  const values = buckets.map((bucket) => averageHitPercent(bucket));

  lines.push(...renderBarChart(theme, values, chartHeight));
  lines.push(...xAxisFooter(theme, values.length, messages.length, "   "));
  lines.push("");

  const recentCount = Math.min(8, messages.length);
  const recent = messages.slice(-recentCount);
  lines.push(theme.fg("accent", theme.bold(`Recent ${recentCount} turns`)));
  lines.push(theme.fg("dim", "* = on current active branch"));
  for (const message of recent) {
    const label = `#${String(message.sequence).padStart(2, " ")}${message.isOnActiveBranch ? "*" : " "}`;
    lines.push(
      `${theme.fg("muted", label)} ${formatPercent(message.cacheHitPercent).padStart(6, " ")}  ` +
        `in ${formatInt(message.input).padStart(6, " ")}  ` +
        `cache ${formatInt(message.cacheRead).padStart(6, " ")}  ` +
        theme.fg("dim", `${message.provider}/${message.model}`),
    );
  }
  return lines;
}

function renderCumulativePercent(
  theme: Theme,
  messages: AssistantUsageMetric[],
  chartWidth: number,
  cumSeries: CumulativeSeries,
): string[] {
  const lines: string[] = [];
  const chartHeight = 10;
  const bucketed = bucketMax(cumSeries.cumHitPercent, chartWidth);

  lines.push(...renderBarChart(theme, bucketed, chartHeight));
  lines.push(...xAxisFooter(theme, bucketed.length, messages.length, "   "));
  lines.push("");

  const recentCount = Math.min(8, messages.length);
  const startIdx = messages.length - recentCount;
  const recent = messages.slice(-recentCount);
  lines.push(theme.fg("accent", theme.bold(`Recent ${recentCount} turns`)));
  lines.push(
    theme.fg("dim", "* = on current active branch  |  values are aggregate (running) totals"),
  );
  for (let i = 0; i < recent.length; i += 1) {
    const message = recent[i];
    const label = `#${String(message.sequence).padStart(2, " ")}${message.isOnActiveBranch ? "*" : " "}`;
    const hitPct = cumSeries.cumHitPercent[startIdx + i];
    const cInput = cumSeries.cumInput[startIdx + i];
    const cRead = cumSeries.cumCacheRead[startIdx + i];
    lines.push(
      `${theme.fg("muted", label)} ${formatPercent(hitPct).padStart(6, " ")}  ` +
        `aggIn ${formatInt(cInput).padStart(7, " ")}  ` +
        `aggHit ${formatInt(cRead).padStart(7, " ")}  ` +
        theme.fg("dim", `${message.provider}/${message.model}`),
    );
  }
  return lines;
}

function renderCumulativeTotal(
  theme: Theme,
  messages: AssistantUsageMetric[],
  chartWidth: number,
  cumSeries: CumulativeSeries,
): string[] {
  const lines: string[] = [];
  const chartHeight = 10;
  const bucketedInput = bucketMax(cumSeries.cumInput, chartWidth);
  const bucketedRead = bucketMax(cumSeries.cumCacheRead, chartWidth);
  const bucketedWrite = bucketMax(cumSeries.cumCacheWrite, chartWidth);

  const { lines: chartLines, unitTokens } = renderStackedSeriesChart(
    theme,
    bucketedInput,
    bucketedRead,
    bucketedWrite,
    chartHeight,
  );
  lines.push(...chartLines);
  lines.push(...xAxisFooter(theme, bucketedInput.length, messages.length, "     "));
  lines.push("");

  // Legend
  lines.push(
    theme.fg("muted", "▇") +
      theme.fg("dim", " input (uncached)   ") +
      theme.fg("warning", "░") +
      theme.fg("dim", " cache write   ") +
      theme.fg("accent", "▒") +
      theme.fg("dim", " cache read (hit)   ") +
      theme.fg("dim", `1 row = ${formatInt(unitTokens)} tokens`),
  );
  lines.push("");

  const recentCount = Math.min(8, messages.length);
  const startIdx = messages.length - recentCount;
  const recent = messages.slice(-recentCount);
  lines.push(theme.fg("accent", theme.bold(`Recent ${recentCount} turns`)));
  lines.push(
    theme.fg("dim", "* = on current active branch  |  values are aggregate (running) totals"),
  );
  for (let i = 0; i < recent.length; i += 1) {
    const message = recent[i];
    const label = `#${String(message.sequence).padStart(2, " ")}${message.isOnActiveBranch ? "*" : " "}`;
    lines.push(
      `${theme.fg("muted", label)} ` +
        `aggIn ${formatInt(cumSeries.cumInput[startIdx + i]).padStart(7, " ")}  ` +
        `aggWrite ${formatInt(cumSeries.cumCacheWrite[startIdx + i]).padStart(7, " ")}  ` +
        `aggHit ${formatInt(cumSeries.cumCacheRead[startIdx + i]).padStart(7, " ")}  ` +
        theme.fg("dim", `${message.provider}/${message.model}`),
    );
  }
  return lines;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function renderGraphBody(
  theme: Theme,
  metrics: CacheSessionMetrics,
  width: number,
  view: GraphView = "per-turn",
): string[] {
  const messages = metrics.allMessages;
  const lines: string[] = [
    theme.fg(
      "accent",
      theme.bold(`Cache hit trend (whole session timeline) — ${graphViewLabel(view)}`),
    ),
  ];

  switch (view) {
    case "per-turn":
      lines.push(
        theme.fg("dim", "Per-turn cache hit % = cacheRead / (input + cacheRead + cacheWrite)"),
      );
      break;
    case "cumulative-percent":
      lines.push(
        theme.fg(
          "dim",
          "Aggregate hit % = aggCacheRead / (aggInput + aggCacheRead + aggCacheWrite)",
        ),
      );
      break;
    case "cumulative-total":
      lines.push(
        theme.fg("dim", "Aggregate (cumulative) token volumes: input  ░ cacheWrite  ▒ cacheRead"),
      );
      break;
  }

  lines.push("");
  lines.push(formatTotalsLine("Active branch", metrics.activeBranchTotals));
  lines.push(formatTotalsLine("Whole tree", metrics.treeTotals));
  lines.push("");

  if (messages.length === 0) {
    lines.push(
      theme.fg(
        "warning",
        "No assistant messages with usage data are available yet in this session.",
      ),
    );
    return lines;
  }

  // Summary stats line
  if (view === "per-turn") {
    const latest = messages.at(-1)!;
    lines.push(
      [
        `Latest: ${formatPercent(latest.cacheHitPercent)}`,
        `Min: ${formatPercent(minHitPercent(messages))}`,
        `Max: ${formatPercent(maxHitPercent(messages))}`,
        `Turns: ${formatInt(messages.length)}`,
      ].join(" • "),
    );
  } else {
    lines.push(`Turns: ${formatInt(messages.length)}`);
  }
  lines.push("");

  const chartWidth = Math.max(10, width - 8);

  switch (view) {
    case "per-turn":
      lines.push(...renderPerTurnPercent(theme, messages, chartWidth));
      break;
    case "cumulative-percent": {
      const cumSeries = computeCumulativeSeries(messages);
      lines.push(...renderCumulativePercent(theme, messages, chartWidth, cumSeries));
      break;
    }
    case "cumulative-total": {
      const cumSeries = computeCumulativeSeries(messages);
      lines.push(...renderCumulativeTotal(theme, messages, chartWidth, cumSeries));
      break;
    }
  }

  return lines;
}
