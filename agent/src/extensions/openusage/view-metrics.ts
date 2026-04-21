import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
  formatRemainingPercent,
  formatReset,
  formatUsedPercent,
  getMetricPaceDetails,
  getRemainingPercent,
  type OpenUsageDisplayMode,
  type PaceStatus,
} from "./status.js";
import type { ResetTimeFormat, SupportedProviderId, UsageMetric } from "./types.js";

function renderMetricSection(
  theme: Theme,
  label: string,
  metric: UsageMetric | undefined,
  width: number,
  resetTimeFormat: ResetTimeFormat,
  displayMode: OpenUsageDisplayMode,
): string[] {
  const muted = (s: string) => theme.fg("muted", s);
  const text = (s: string) => theme.fg("text", s);
  const now = Date.now();

  if (!metric) {
    return [muted(`${label}: `) + text("n/a")];
  }

  const reset = formatReset(metric.resetsAt, resetTimeFormat, now);
  const pace = getMetricPaceDetails(metric, displayMode, now);
  const statusText = typeof pace.statusText === "string" ? pace.statusText : undefined;
  const projectedText = typeof pace.projectedText === "string" ? pace.projectedText : undefined;
  const runsOutText = typeof pace.runsOutText === "string" ? pace.runsOutText : undefined;
  const paceHeader = renderMetricPaceHeader(
    theme,
    label,
    statusText,
    projectedText,
    pace.paceResult?.status,
  );

  const primaryText =
    displayMode === "used"
      ? `${formatUsedPercent(metric)} used`
      : `${formatRemainingPercent(metric)} left`;
  const footerLeft =
    displayMode === "used"
      ? colorUsed(theme, metric, primaryText)
      : colorRemaining(theme, metric, primaryText);
  const footerRight =
    reset !== undefined && reset.length > 0
      ? `${muted("resets ")}${text(reset)}`
      : text(`${formatUsedPercent(metric)} / ${formatRemainingPercent(metric)}`);

  const bar = renderMetricSectionBar(theme, metric, width, displayMode, pace.elapsedPercent);

  const lines = [paceHeader, bar, composeMetricFooter(footerLeft, footerRight, width)];
  if (runsOutText !== undefined && runsOutText.length > 0) {
    lines.push(theme.fg("error", runsOutText));
  }
  return lines;
}

function renderMetricSectionBar(
  theme: Theme,
  metric: UsageMetric,
  width: number,
  displayMode: OpenUsageDisplayMode,
  elapsedPercent: number | null,
): string {
  const muted = (s: string) => theme.fg("muted", s);
  const barWidth = Math.max(10, Math.min(36, width - 12));
  return (
    renderMetricBar(theme, metric, barWidth, displayMode, elapsedPercent) +
    " " +
    theme.fg("dim", "used") +
    (displayMode === "used" ? colorUsed(theme, metric, "█") : theme.fg("dim", "█")) +
    " " +
    theme.fg("dim", "left") +
    (displayMode === "used" ? theme.fg("dim", "█") : colorRemaining(theme, metric, "█")) +
    (elapsedPercent === null ? "" : `${muted(" pace ")}${theme.fg("accent", "▏")}`)
  );
}

function renderMetricPaceHeader(
  theme: Theme,
  label: string,
  statusText: string | undefined,
  projectedText: string | undefined,
  paceStatus: PaceStatus | undefined,
): string {
  const muted = (s: string) => theme.fg("muted", s);
  const text = (s: string) => theme.fg("text", s);
  if (typeof statusText !== "string" || statusText.length === 0) {
    return muted(label);
  }

  const projected =
    typeof projectedText === "string" && projectedText.length > 0
      ? `${muted(" · ")}${text(projectedText)}`
      : "";
  return `${muted(`${label} `)}${colorForPaceStatus(theme, paceStatus, "●")} ${colorForPaceStatus(theme, paceStatus, statusText)}${projected}`;
}

function renderMetricBar(
  theme: Theme,
  metric: UsageMetric,
  width: number,
  displayMode: OpenUsageDisplayMode,
  elapsedPercent: number | null,
): string {
  const safeWidth = Math.max(10, width);
  const usedRatio =
    Number.isFinite(metric.used) && Number.isFinite(metric.limit) && metric.limit > 0
      ? Math.max(0, Math.min(1, metric.used / metric.limit))
      : 0;
  const usedCols = Math.max(0, Math.min(safeWidth, Math.round(usedRatio * safeWidth)));
  const chars = Array.from<string>({ length: safeWidth });
  for (let i = 0; i < safeWidth; i++) {
    const isUsed = i < usedCols;
    if (isUsed) {
      chars[i] = displayMode === "used" ? colorUsed(theme, metric, "█") : theme.fg("dim", "█");
    } else {
      chars[i] = displayMode === "used" ? theme.fg("dim", "█") : colorRemaining(theme, metric, "█");
    }
  }

  if (elapsedPercent !== null && Number.isFinite(elapsedPercent)) {
    const markerRatio = Math.max(0, Math.min(1, elapsedPercent / 100));
    const markerIndex = Math.max(
      0,
      Math.min(safeWidth - 1, Math.round(markerRatio * (safeWidth - 1))),
    );
    chars[markerIndex] = theme.fg("accent", "▏");
  }

  return chars.join("");
}

function colorRemaining(theme: Theme, metric: UsageMetric, value: string): string {
  const remaining = getRemainingPercent(metric);
  if (remaining === undefined) {
    return theme.fg("muted", value);
  }
  if (remaining <= 15) {
    return theme.fg("error", value);
  }
  if (remaining <= 35) {
    return theme.fg("warning", value);
  }
  return theme.fg("success", value);
}

function colorUsed(theme: Theme, metric: UsageMetric, value: string): string {
  const remaining = getRemainingPercent(metric);
  if (remaining === undefined) {
    return theme.fg("muted", value);
  }
  if (remaining <= 15) {
    return theme.fg("error", value);
  }
  if (remaining <= 35) {
    return theme.fg("warning", value);
  }
  return theme.fg("success", value);
}

function colorForPaceStatus(theme: Theme, status: PaceStatus | undefined, value: string): string {
  if (status === "behind") {
    return theme.fg("error", value);
  }
  if (status === "on-track") {
    return theme.fg("warning", value);
  }
  if (status === "ahead") {
    return theme.fg("success", value);
  }
  return theme.fg("muted", value);
}

function composeMetricFooter(left: string, right: string, width: number): string {
  const safeWidth = Math.max(10, width - 4);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= safeWidth) {
    return truncateToWidth(right, safeWidth, "");
  }

  const gap = left && right ? 1 : 0;
  const leftBudget = Math.max(0, safeWidth - rightWidth - gap);
  const leftPart = truncateToWidth(left, leftBudget, "…");
  const leftWidth = visibleWidth(leftPart);
  const spacer = " ".repeat(Math.max(0, safeWidth - leftWidth - rightWidth));
  return `${leftPart}${spacer}${right}`;
}

function providerDisplayName(providerId: SupportedProviderId): string {
  if (providerId === "zai") {
    return "Z.ai";
  }
  if (providerId === "google") {
    return "Google";
  }
  return "Codex";
}

function formatAge(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "unknown";
  }

  const diff = Date.now() - timestamp;
  if (diff <= 0) {
    return "just now";
  }

  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  const days = Math.floor(diff / dayMs);
  const hours = Math.floor((diff % dayMs) / hourMs);
  const minutes = Math.max(1, Math.floor((diff % hourMs) / minuteMs));

  if (days > 0) {
    return `${days}d ${hours}h ago`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ago`;
  }
  return `${minutes}m ago`;
}

export { formatAge, providerDisplayName, renderMetricSection };
