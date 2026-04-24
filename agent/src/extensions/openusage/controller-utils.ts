import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveSupportedProviderId } from "./model-map.js";
import { getRemainingPercent, renderStatusText, setStatus } from "./status.js";
import { createRuntimeState } from "./state.js";
import {
  OPENUSAGE_ALERT_EVENT,
  OPENUSAGE_SESSION_ALERT_THRESHOLD_PERCENT,
  OPENUSAGE_UPDATED_EVENT,
  OPENUSAGE_WEEKLY_ALERT_THRESHOLD_PERCENT,
  type OpenUsageAlertEvent,
  type SupportedProviderId,
  type UsageMetric,
  type UsageSnapshot,
} from "./types.js";

type OpenUsageState = ReturnType<typeof createRuntimeState>;

export async function resolveAndRefreshProvider(
  provider: string | undefined,
  modelId: string | undefined,
  ctx: ExtensionContext,
  refreshFn: (
    providerId: SupportedProviderId,
    ctx: ExtensionContext,
    options: { force?: boolean },
  ) => Promise<void>,
  publishFn: (ctx: ExtensionContext, snapshot: UsageSnapshot | undefined, active: boolean) => void,
  options: { force?: boolean } = {},
): Promise<void> {
  const providerId = resolveSupportedProviderId(provider, modelId);
  if (!providerId) {
    publishFn(ctx, undefined, true);
    return;
  }
  await refreshFn(providerId, ctx, options);
}

export function publishUsageUpdate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: UsageSnapshot | undefined,
  active: boolean,
): void {
  if (active) {
    setStatus(ctx, snapshot);
  }

  pi.events.emit(OPENUSAGE_UPDATED_EVENT, {
    active,
    providerId: snapshot?.providerId,
    snapshot,
  });
}

export function emitThresholdAlerts(
  pi: ExtensionAPI,
  state: OpenUsageState,
  snapshot: UsageSnapshot,
): void {
  maybeEmitThresholdAlert(
    pi,
    state,
    snapshot,
    "session5h",
    snapshot.session5h,
    OPENUSAGE_SESSION_ALERT_THRESHOLD_PERCENT,
  );
  maybeEmitThresholdAlert(
    pi,
    state,
    snapshot,
    "weekly",
    snapshot.weekly,
    OPENUSAGE_WEEKLY_ALERT_THRESHOLD_PERCENT,
  );
}

export function handleRefreshError(
  pi: ExtensionAPI,
  state: OpenUsageState,
  providerId: SupportedProviderId,
  ctx: ExtensionContext,
  error: unknown,
): void {
  const cached = state.snapshots.get(providerId);
  const isActive = providerId === resolveSupportedProviderId(ctx.model?.provider, ctx.model?.id);
  if (cached) {
    publishUsageUpdate(pi, ctx, cached, isActive);
    return;
  }

  if (isActive) {
    const text = renderUnavailableStatusText(ctx, cached, providerId);
    if (state.lastPublishedStatusText !== text) {
      state.lastPublishedStatusText = text;
      ctx.ui.setStatus("openusage", text);
    }
    pi.events.emit(OPENUSAGE_UPDATED_EVENT, { active: true, providerId, snapshot: undefined });
  }

  void error;
}

export function publishUsageUpdateIfChanged(
  pi: ExtensionAPI,
  state: OpenUsageState,
  ctx: ExtensionContext,
  snapshot: UsageSnapshot | undefined,
  active: boolean,
): void {
  if (active) {
    const nextText = renderStatusText(ctx, snapshot);
    if (state.lastPublishedStatusText === nextText) {
      return;
    }
    state.lastPublishedStatusText = nextText;
  }

  publishUsageUpdate(pi, ctx, snapshot, active);
}

export function formatAlertMessage(alert: OpenUsageAlertEvent): string {
  const metricLabel =
    alert.snapshot.metricLabels?.[alert.metric] ?? (alert.metric === "weekly" ? "weekly" : "5h");
  const remaining = formatPercent(alert.remainingPercent);
  const threshold = formatPercent(alert.thresholdPercent);
  return `OpenUsage ${alert.displayName}: ${metricLabel} remaining ${remaining} (≤ ${threshold})`;
}

function maybeEmitThresholdAlert(
  pi: ExtensionAPI,
  state: OpenUsageState,
  snapshot: UsageSnapshot,
  metricKind: "session5h" | "weekly",
  metric: UsageMetric | undefined,
  thresholdPercent: number,
): void {
  const remainingPercent = metric ? getRemainingPercent(metric) : undefined;
  if (remainingPercent === undefined || remainingPercent > thresholdPercent) {
    return;
  }

  const alertKey = `${snapshot.providerId}:${metricKind}:${metric?.resetsAt ?? "none"}:${thresholdPercent}`;
  if (state.notifiedAlerts.has(alertKey)) {
    return;
  }

  state.notifiedAlerts.add(alertKey);
  pi.events.emit(OPENUSAGE_ALERT_EVENT, {
    providerId: snapshot.providerId,
    displayName: snapshot.displayName,
    metric: metricKind,
    remainingPercent,
    thresholdPercent,
    resetsAt: metric?.resetsAt,
    snapshot,
  });
}

function getMetricLabels(
  snapshot: UsageSnapshot | undefined,
  providerId: SupportedProviderId,
): {
  session: string;
  weekly: string;
} {
  return {
    session: snapshot?.metricShortLabels?.session5h ?? (providerId === "google" ? "P24" : "5h"),
    weekly: snapshot?.metricShortLabels?.weekly ?? (providerId === "google" ? "F24" : "wk"),
  };
}

function renderUnavailableStatusText(
  ctx: ExtensionContext,
  snapshot: UsageSnapshot | undefined,
  providerId: SupportedProviderId,
): string {
  const theme = ctx.ui.theme;
  const labels = getMetricLabels(snapshot, providerId);
  return `${theme.fg("dim", `${labels.session} `)}${theme.fg("warning", "n/a")}${theme.fg("dim", ` ${labels.weekly} `)}${theme.fg("warning", "n/a")}`;
}

function formatPercent(value: number): string {
  const rounded = Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}
