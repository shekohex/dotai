import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerOpenUsageCommands } from "./commands.js";
import {
  emitThresholdAlerts,
  formatAlertMessage,
  handleRefreshError,
  publishUsageUpdateIfChanged,
  resolveAndRefreshProvider,
} from "./controller-utils.js";
import { parseAlertEvent, parseModeChangedEvent } from "./events.js";
import { resolveSupportedProviderId } from "./model-map.js";
import { createRuntimeState, restorePersistedState } from "./state.js";
import {
  OPENUSAGE_ALERT_EVENT,
  OPENUSAGE_CACHE_TTL_MS,
  OPENUSAGE_REFRESH_INTERVAL_MS,
  type SupportedProviderId,
} from "./types.js";
import { usageProviders } from "./providers/index.js";

type OpenUsageState = ReturnType<typeof createRuntimeState>;

export class OpenUsageController {
  private readonly state: OpenUsageState;
  private currentCtx: ExtensionContext | undefined;
  private unsubscribeAlert: (() => void) | undefined;

  constructor(private readonly pi: ExtensionAPI) {
    this.state = createRuntimeState();
  }

  register(): void {
    this.unsubscribeAlert = this.pi.events.on(OPENUSAGE_ALERT_EVENT, (data) => {
      this.onAlert(data);
    });
    this.pi.on("session_start", (_event, ctx) => this.onSessionStart(ctx));
    this.pi.on("model_select", (_event, ctx) => this.onModelSelect(ctx));
    this.pi.events.on("modes:changed", (data) => {
      void this.onModeChanged(data);
    });
    this.pi.on("agent_end", (_event, ctx) => this.refreshActiveProvider(ctx, { force: false }));
    this.pi.on("session_shutdown", (_event, ctx) => {
      this.onSessionShutdown(ctx);
    });
    registerOpenUsageCommands(this.pi, this.state, (providerId, ctx, options) =>
      this.refreshProvider(providerId, ctx, options),
    );
  }

  private onAlert(data: unknown): void {
    if (this.currentCtx?.hasUI !== true) {
      return;
    }

    const alert = parseAlertEvent(data);
    if (alert) {
      this.currentCtx.ui.notify(formatAlertMessage(alert), "warning");
    }
  }

  private async onSessionStart(ctx: ExtensionContext): Promise<void> {
    this.currentCtx = ctx;
    this.state.notifiedAlerts.clear();
    this.state.lastPublishedStatusText = undefined;
    this.state.persisted = restorePersistedState(ctx.sessionManager.getBranch());
    await this.refreshActiveProvider(ctx, { force: false });
    this.schedulePublishCurrentModelUsage(ctx);
    this.startInterval(ctx);
  }

  private async onModelSelect(ctx: ExtensionContext): Promise<void> {
    await this.refreshActiveProvider(ctx, { force: false });
    this.publishCurrentModelUsage(ctx);
    this.schedulePublishCurrentModelUsage(ctx);
  }

  private async onModeChanged(data: unknown): Promise<void> {
    const event = parseModeChangedEvent(data);
    const ctx = this.currentCtx;
    if (!event || !ctx || event.cwd !== ctx.cwd) {
      return;
    }

    try {
      await resolveAndRefreshProvider(
        event.spec?.provider,
        event.spec?.modelId,
        ctx,
        (providerId, targetCtx, options) => this.refreshProvider(providerId, targetCtx, options),
        (targetCtx, snapshot, active) => {
          publishUsageUpdateIfChanged(this.pi, this.state, targetCtx, snapshot, active);
        },
        { force: false },
      );
      this.publishUsageForProvider(
        ctx,
        resolveSupportedProviderId(event.spec?.provider, event.spec?.modelId),
      );
      this.schedulePublishCurrentModelUsage(ctx);
    } catch {}
  }

  private onSessionShutdown(ctx: ExtensionContext): void {
    this.currentCtx = undefined;
    this.stopInterval();
    this.unsubscribeAlert?.();
    this.state.lastPublishedStatusText = undefined;
    publishUsageUpdateIfChanged(this.pi, this.state, ctx, undefined, true);
  }

  private async refreshActiveProvider(
    ctx: ExtensionContext,
    options: { force?: boolean },
  ): Promise<void> {
    try {
      await resolveAndRefreshProvider(
        ctx.model?.provider,
        ctx.model?.id,
        ctx,
        (providerId, targetCtx, refreshOptions) =>
          this.refreshProvider(providerId, targetCtx, refreshOptions),
        (targetCtx, snapshot, active) => {
          publishUsageUpdateIfChanged(this.pi, this.state, targetCtx, snapshot, active);
        },
        options,
      );
    } catch {}
  }

  private publishCurrentModelUsage(ctx: ExtensionContext): void {
    this.publishUsageForProvider(
      ctx,
      resolveSupportedProviderId(ctx.model?.provider, ctx.model?.id),
    );
  }

  private publishUsageForProvider(
    ctx: ExtensionContext,
    providerId: SupportedProviderId | undefined,
  ): void {
    if (!providerId) {
      return;
    }

    const snapshot = this.state.snapshots.get(providerId);
    if (snapshot) {
      publishUsageUpdateIfChanged(this.pi, this.state, ctx, snapshot, true);
    }
  }

  private schedulePublishCurrentModelUsage(ctx: ExtensionContext): void {
    setTimeout(() => {
      if (this.currentCtx === ctx) {
        this.publishCurrentModelUsage(ctx);
      }
    }, 150);
  }

  private async refreshProvider(
    providerId: SupportedProviderId,
    ctx: ExtensionContext,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const provider = usageProviders.find((entry) => entry.id === providerId);
    if (!provider) {
      return;
    }

    if (this.tryPublishCachedSnapshot(providerId, ctx, options.force === true)) {
      return;
    }
    if (await this.tryPublishInFlightSnapshot(providerId, ctx)) {
      return;
    }

    await this.fetchAndPublishProviderSnapshot(providerId, provider, ctx);
  }

  private tryPublishCachedSnapshot(
    providerId: SupportedProviderId,
    ctx: ExtensionContext,
    forceRefresh: boolean,
  ): boolean {
    const cached = this.state.snapshots.get(providerId);
    if (
      forceRefresh ||
      cached === undefined ||
      Date.now() - cached.fetchedAt >= OPENUSAGE_CACHE_TTL_MS
    ) {
      return false;
    }

    const isActive = providerId === resolveSupportedProviderId(ctx.model?.provider, ctx.model?.id);
    publishUsageUpdateIfChanged(this.pi, this.state, ctx, cached, isActive);
    if (isActive) {
      emitThresholdAlerts(this.pi, this.state, cached);
    }
    return true;
  }

  private async tryPublishInFlightSnapshot(
    providerId: SupportedProviderId,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    const currentInFlight = this.state.inFlight.get(providerId);
    if (!currentInFlight) {
      return false;
    }

    try {
      const snapshot = await currentInFlight;
      const isActive =
        providerId === resolveSupportedProviderId(ctx.model?.provider, ctx.model?.id);
      publishUsageUpdateIfChanged(this.pi, this.state, ctx, snapshot, isActive);
      if (isActive) {
        emitThresholdAlerts(this.pi, this.state, snapshot);
      }
    } catch (error) {
      handleRefreshError(this.pi, this.state, providerId, ctx, error);
    }
    return true;
  }

  private async fetchAndPublishProviderSnapshot(
    providerId: SupportedProviderId,
    provider: (typeof usageProviders)[number],
    ctx: ExtensionContext,
  ): Promise<void> {
    const task = provider.fetchSnapshot(ctx, this.state);
    this.state.inFlight.set(providerId, task);

    try {
      const snapshot = await task;
      this.state.snapshots.set(providerId, snapshot);
      const isActive =
        providerId === resolveSupportedProviderId(ctx.model?.provider, ctx.model?.id);
      publishUsageUpdateIfChanged(this.pi, this.state, ctx, snapshot, isActive);
      if (isActive) {
        emitThresholdAlerts(this.pi, this.state, snapshot);
      }
    } catch (error) {
      handleRefreshError(this.pi, this.state, providerId, ctx, error);
      throw error;
    } finally {
      this.state.inFlight.delete(providerId);
    }
  }

  private startInterval(ctx: ExtensionContext): void {
    this.stopInterval();
    this.state.interval = setInterval(() => {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        return;
      }

      void this.refreshActiveProvider(ctx, { force: true }).catch(() => {});
    }, OPENUSAGE_REFRESH_INTERVAL_MS);
  }

  private stopInterval(): void {
    if (this.state.interval) {
      clearInterval(this.state.interval);
      this.state.interval = undefined;
    }
  }
}
