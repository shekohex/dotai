import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";

import { errorMessage } from "../utils/error-message.js";
import type { GlobalConductorConfig } from "./config.js";
import type { ConductorLogger } from "./logging.js";
import type { ConductorOrchestrator, ReconcileScope } from "./orchestrator.js";
import { createPollingPlans, type PollingPlan } from "./polling-schedule.js";
import { isRateLimitError, rateLimitRetryAt } from "./rate-limit.js";
import type { ConductorStore } from "./store/types.js";
import { processPendingWebhookDeliveries } from "./webhook.js";

export { createPollingPlans, isRateLimitError };

export type ReconcileFailure = { error: unknown } | null;
export type PollingController = { close(): void };

export function startConductorPolling(input: {
  config: GlobalConductorConfig;
  logger: ConductorLogger;
  orchestrator: ConductorOrchestrator;
  store: ConductorStore;
}): PollingController {
  const controllers = createPollingPlans(input.config).map((plan) =>
    startPollingPlan(input.orchestrator, input.logger, plan),
  );
  if (input.config.webhook !== undefined) {
    controllers.push(startWebhookRecoveryTimer(input.orchestrator, input.store, input.logger));
  }
  return {
    close() {
      for (const controller of controllers) controller.close();
    },
  };
}

export async function runReconcileSafely(
  orchestrator: ConductorOrchestrator,
  logger: ConductorLogger,
  scope?: ReconcileScope,
): Promise<ReconcileFailure> {
  try {
    const startedAt = Date.now();
    const runs = await orchestrator.reconcile(scope);
    const context = {
      dispatched: runs.length,
      durationMs: Date.now() - startedAt,
      projectScan: scope?.projectScan !== false,
    };
    if (runs.length > 0) logger.info("Conductor reconcile dispatched runs", context);
    else logger.debug("Conductor reconcile finished", context);
    return null;
  } catch (error) {
    logger.error("Conductor reconcile failed", { error: errorMessage(error) });
    return { error };
  }
}

function startPollingPlan(
  orchestrator: ConductorOrchestrator,
  logger: ConductorLogger,
  plan: PollingPlan,
): PollingController {
  let closed = false;
  let running = false;
  let backoffUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (closed) return;
    timer = setTimeout(run, jitteredIntervalMs(plan.intervalSeconds));
  };
  const run = (): void => {
    if (closed) return;
    if (running || Date.now() < backoffUntil) {
      schedule();
      return;
    }
    running = true;
    logger.debug("Conductor polling tick started", {
      activeRuns: plan.activeRuns,
      projectScan: plan.projectScan,
      reason: plan.reason,
      repositories: plan.repositories,
    });
    void runReconcileSafely(orchestrator, logger, {
      activeRuns: plan.activeRuns,
      projectScan: plan.projectScan,
      reason: plan.reason,
      repositories: plan.repositories,
    })
      .then((failure) => {
        if (failure === null || !isRateLimitError(failure.error)) return;
        backoffUntil = rateLimitRetryAt(failure.error).getTime();
        logger.warn("Conductor polling backed off after GitHub rate limit", {
          reason: plan.reason,
          until: new Date(backoffUntil).toISOString(),
        });
      })
      .finally(() => {
        running = false;
        logger.debug("Conductor polling tick finished", { reason: plan.reason });
        schedule();
      });
  };
  schedule();
  return {
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function startWebhookRecoveryTimer(
  orchestrator: ConductorOrchestrator,
  store: ConductorStore,
  logger: ConductorLogger,
): PollingController {
  const interval = setInterval(() => {
    void processPendingWebhookDeliveries({
      store,
      orchestrator,
      onError: (message) => {
        logger.warn(message.trim());
      },
    }).catch((error: unknown) => {
      logger.error("Conductor webhook delivery recovery failed", {
        error: errorMessage(error),
      });
    });
  }, 60_000);
  return {
    close() {
      clearInterval(interval);
    },
  };
}

function jitteredIntervalMs(intervalSeconds: number): number {
  return Math.round(intervalSeconds * 1000 * (0.9 + Math.random() * 0.2));
}
