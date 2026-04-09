import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { ModeChangedEvent } from "../modes.js";
import { registerOpenUsageCommands } from "./commands.js";
import { resolveSupportedProviderId } from "./model-map.js";
import { getRemainingPercent, setStatus } from "./status.js";
import { createRuntimeState, restorePersistedState } from "./state.js";
import {
  OPENUSAGE_ALERT_EVENT,
  OPENUSAGE_CACHE_TTL_MS,
  OPENUSAGE_REFRESH_INTERVAL_MS,
  OPENUSAGE_SESSION_ALERT_THRESHOLD_PERCENT,
  OPENUSAGE_UPDATED_EVENT,
  OPENUSAGE_WEEKLY_ALERT_THRESHOLD_PERCENT,
  type OpenUsageAlertEvent,
  type SupportedProviderId,
  type UsageMetric,
  type UsageSnapshot,
} from "./types.js";
import { usageProviders } from "./providers/index.js";

async function resolveAndRefreshProvider(
  provider: string | undefined,
  modelId: string | undefined,
  ctx: ExtensionContext,
  state: ReturnType<typeof createRuntimeState>,
  refreshFn: (providerId: SupportedProviderId, ctx: ExtensionContext, options: { force?: boolean }) => Promise<void>,
  publishFn: (ctx: ExtensionContext, snapshot: UsageSnapshot | undefined, active: boolean) => void,
): Promise<void> {
  const providerId = resolveSupportedProviderId(provider, modelId);
  if (!providerId) {
    publishFn(ctx, undefined, true);
    return;
  }
  await refreshFn(providerId, ctx, { force: false });
}

export default function openUsageExtension(pi: ExtensionAPI) {
  const state = createRuntimeState();
  let currentCtx: ExtensionContext | undefined;

  const unsubscribeAlert = pi.events.on(OPENUSAGE_ALERT_EVENT, (data) => {
    if (!currentCtx?.hasUI) {
      return;
    }

    const alert = data as OpenUsageAlertEvent;
    currentCtx.ui.notify(formatAlertMessage(alert), "warning");
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    state.notifiedAlerts.clear();
    state.persisted = restorePersistedState(ctx.sessionManager.getBranch());
    await refreshActiveProvider(ctx, { force: false });
    startInterval(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    await refreshActiveProvider(ctx, { force: false });
  });

  pi.events.on("modes:changed", async (data) => {
    const event = data as ModeChangedEvent;
    const ctx = currentCtx;

    if (!ctx) return;
    if (event.cwd !== ctx.cwd) return;

    try {
      await resolveAndRefreshProvider(
        event.spec?.provider,
        event.spec?.modelId,
        ctx,
        state,
        refreshProvider,
        publishUsageUpdate,
      );
    } catch {
      return;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    await refreshActiveProvider(ctx, { force: false });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    currentCtx = undefined;
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
    unsubscribeAlert();
    publishUsageUpdate(ctx, undefined, true);
  });

  registerOpenUsageCommands(pi, state, refreshProvider);

  async function refreshActiveProvider(
    ctx: ExtensionContext,
    options: { force?: boolean },
  ): Promise<void> {
    try {
      await resolveAndRefreshProvider(
        ctx.model?.provider,
        ctx.model?.id,
        ctx,
        state,
        refreshProvider,
        publishUsageUpdate,
      );
    } catch {
      return;
    }
  }

  async function refreshProvider(
    providerId: SupportedProviderId,
    ctx: ExtensionContext,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const provider = usageProviders.find((entry) => entry.id === providerId);
    if (!provider) {
      return;
    }

    const cached = state.snapshots.get(providerId);
    if (
      !options.force &&
      cached &&
      Date.now() - cached.fetchedAt < OPENUSAGE_CACHE_TTL_MS
    ) {
      if (
        providerId ===
        resolveSupportedProviderId(ctx.model?.provider, ctx.model?.id)
      ) {
        publishUsageUpdate(ctx, cached, true);
        emitThresholdAlerts(cached);
      } else {
        publishUsageUpdate(ctx, cached, false);
      }
      return;
    }

    const currentInFlight = state.inFlight.get(providerId);
    if (currentInFlight) {
      try {
        const snapshot = await currentInFlight;
        const isActive =
          providerId ===
          resolveSupportedProviderId(ctx.model?.provider, ctx.model?.id);
        publishUsageUpdate(ctx, snapshot, isActive);
        if (isActive) {
          emitThresholdAlerts(snapshot);
        }
      } catch (error) {
        handleRefreshError(providerId, ctx, error);
      }
      return;
    }

    const task = provider.fetchSnapshot(ctx, state);
    state.inFlight.set(providerId, task);

    try {
      const snapshot = await task;
      state.snapshots.set(providerId, snapshot);
      const isActive =
        providerId ===
        resolveSupportedProviderId(ctx.model?.provider, ctx.model?.id);
      publishUsageUpdate(ctx, snapshot, isActive);
      if (isActive) {
        emitThresholdAlerts(snapshot);
      }
    } catch (error) {
      handleRefreshError(providerId, ctx, error);
      throw error;
    } finally {
      state.inFlight.delete(providerId);
    }
  }

  function startInterval(ctx: ExtensionContext): void {
    if (state.interval) {
      clearInterval(state.interval);
    }

    state.interval = setInterval(() => {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        return;
      }

      void refreshActiveProvider(ctx, { force: true }).catch(() => undefined);
    }, OPENUSAGE_REFRESH_INTERVAL_MS);
  }

  function handleRefreshError(
    providerId: SupportedProviderId,
    ctx: ExtensionContext,
    error: unknown,
  ): void {
    const cached = state.snapshots.get(providerId);
    const isActive =
      providerId ===
      resolveSupportedProviderId(ctx.model?.provider, ctx.model?.id);

    if (cached) {
      publishUsageUpdate(ctx, cached, isActive);
      return;
    }

    if (isActive) {
      const theme = ctx.ui.theme;
      ctx.ui.setStatus(
        "openusage",
        `${theme.fg("dim", "5h ")}${theme.fg("warning", "n/a")}${theme.fg("dim", " wk ")}${theme.fg("warning", "n/a")}`,
      );
      pi.events.emit(OPENUSAGE_UPDATED_EVENT, {
        active: true,
        providerId,
        snapshot: undefined,
      });
    }

    void error;
  }

  function publishUsageUpdate(
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

  function emitThresholdAlerts(snapshot: UsageSnapshot): void {
    maybeEmitThresholdAlert(
      snapshot,
      "session5h",
      snapshot.session5h,
      OPENUSAGE_SESSION_ALERT_THRESHOLD_PERCENT,
    );
    maybeEmitThresholdAlert(
      snapshot,
      "weekly",
      snapshot.weekly,
      OPENUSAGE_WEEKLY_ALERT_THRESHOLD_PERCENT,
    );
  }

  function maybeEmitThresholdAlert(
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
}

function formatAlertMessage(alert: OpenUsageAlertEvent): string {
  const metricLabel = alert.metric === "weekly" ? "weekly" : "5h";
  const remaining = formatPercent(alert.remainingPercent);
  const threshold = formatPercent(alert.thresholdPercent);
  return `OpenUsage ${alert.displayName}: ${metricLabel} remaining ${remaining} (≤ ${threshold})`;
}

function formatPercent(value: number): string {
  const rounded = Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}
