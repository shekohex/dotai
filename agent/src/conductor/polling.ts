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
export type PollingController = { close(): void; ready: Promise<void> };

export function startConductorPolling(input: {
  config: GlobalConductorConfig;
  forceInitial?: boolean;
  logger: ConductorLogger;
  orchestrator: ConductorOrchestrator;
  store: ConductorStore;
}): PollingController {
  const controllers = createPollingPlans(input.config).map((plan) =>
    startPollingPlan(
      input.orchestrator,
      input.store,
      input.logger,
      plan,
      input.forceInitial === true,
    ),
  );
  if (input.config.webhook !== undefined) {
    controllers.push(startWebhookRecoveryTimer(input.orchestrator, input.store, input.logger));
  }
  return {
    ready: Promise.all(controllers.map((controller) => controller.ready)).then(() => {}),
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
    const durationMs = Date.now() - startedAt;
    const context = {
      dispatched: runs.length,
      durationMs,
      projectScan: scope?.projectScan !== false,
      activeRuns: scope?.activeRuns !== false,
      reason: scope?.reason ?? "manual",
      repositories: scope?.repositories?.length,
    };
    if (runs.length > 0) logger.info("Conductor reconcile dispatched runs", context);
    else if (durationMs >= 30_000) logger.warn("Conductor reconcile completed slowly", context);
    else logger.debug("Conductor reconcile finished", context);
    return null;
  } catch (error) {
    logger.error("Conductor reconcile failed", {
      error: errorMessage(error),
      projectScan: scope?.projectScan !== false,
      activeRuns: scope?.activeRuns !== false,
      reason: scope?.reason ?? "manual",
      repositories: scope?.repositories?.length,
    });
    return { error };
  }
}

function startPollingPlan(
  orchestrator: ConductorOrchestrator,
  store: ConductorStore,
  logger: ConductorLogger,
  plan: PollingPlan,
  forceInitial: boolean,
): PollingController {
  let closed = false;
  let running = false;
  let backoffUntil = 0;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const schedule = (delayMs = jitteredIntervalMs(plan.intervalSeconds)): void => {
    if (closed) return;
    timer = globalThis.setTimeout(run, delayMs);
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
    const startedAt = Date.now();
    const slowTimer = globalThis.setTimeout(() => {
      logger.warn("Conductor polling tick still running", {
        activeRuns: plan.activeRuns,
        durationMs: Date.now() - startedAt,
        projectScan: plan.projectScan,
        reason: plan.reason,
        repositories: plan.repositories,
      });
    }, 30_000);
    void runReconcileSafely(orchestrator, logger, {
      activeRuns: plan.activeRuns,
      projectScan: plan.projectScan,
      reason: plan.reason,
      repositories: plan.repositories,
    })
      .then(async (failure) => {
        if (failure === null) {
          try {
            await recordPollingPlanSuccess(store, plan);
            logger.debug("Conductor polling state persisted", {
              durationMs: Date.now() - startedAt,
              reason: plan.reason,
              repositories: plan.repositories.length,
            });
          } catch (error) {
            logger.error("Conductor polling state persistence failed", {
              error: errorMessage(error),
              reason: plan.reason,
            });
          }
          return;
        }
        if (!isRateLimitError(failure.error)) return;
        backoffUntil = rateLimitRetryAt(failure.error).getTime();
        logger.warn("Conductor polling backed off after GitHub rate limit", {
          reason: plan.reason,
          until: new Date(backoffUntil).toISOString(),
        });
      })
      .finally(() => {
        globalThis.clearTimeout(slowTimer);
        running = false;
        logger.debug("Conductor polling tick finished", { reason: plan.reason });
        schedule();
      });
  };
  const ready = (
    forceInitial
      ? Promise.resolve<InitialPollingSchedule>({ delayMs: 0 })
      : initialPollingSchedule(store, plan)
  )
    .then(({ delayMs, lastSuccessAt }) => {
      logger.info(
        delayMs === 0
          ? "Conductor polling plan due; reconciling now"
          : "Conductor polling plan scheduled",
        {
          activeRuns: plan.activeRuns,
          delayMs,
          intervalSeconds: plan.intervalSeconds,
          lastSuccessAt,
          projectScan: plan.projectScan,
          reason: plan.reason,
          repositories: plan.repositories,
          source: pollingScheduleSource(forceInitial, lastSuccessAt),
        },
      );
      if (delayMs === 0) run();
      else schedule(delayMs);
    })
    .catch((error: unknown) => {
      logger.warn("Conductor polling state read failed; reconciling now", {
        error: errorMessage(error),
        reason: plan.reason,
      });
      schedule(0);
    });
  return {
    ready,
    close() {
      closed = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    },
  };
}

type InitialPollingSchedule = { delayMs: number; lastSuccessAt?: string };

function pollingScheduleSource(forceInitial: boolean, lastSuccessAt: string | undefined): string {
  if (forceInitial) return "forced";
  return lastSuccessAt === undefined ? "missing" : "persisted";
}

async function initialPollingSchedule(
  store: ConductorStore,
  plan: PollingPlan,
): Promise<InitialPollingSchedule> {
  const states = await Promise.all(
    plan.repositories.map((repository) =>
      store.getGitHubSyncState(pollingPlanStateKey(plan, repository)),
    ),
  );
  if (states.some((state) => state === undefined)) return { delayMs: 0 };
  const lastSuccessAt = Math.min(...states.map((state) => Date.parse(state?.updatedAt ?? "")));
  if (!Number.isFinite(lastSuccessAt)) return { delayMs: 0 };
  const elapsedMs = Math.max(0, Date.now() - lastSuccessAt);
  return {
    delayMs: Math.max(0, plan.intervalSeconds * 1000 - elapsedMs),
    lastSuccessAt: new Date(lastSuccessAt).toISOString(),
  };
}

async function recordPollingPlanSuccess(store: ConductorStore, plan: PollingPlan): Promise<void> {
  const updatedAt = new Date().toISOString();
  await Promise.all(
    plan.repositories.map((repository) =>
      store.setGitHubSyncState({
        key: pollingPlanStateKey(plan, repository),
        value: { reason: plan.reason },
        updatedAt,
      }),
    ),
  );
}

function pollingPlanStateKey(
  plan: PollingPlan,
  repository: { owner: string; repo: string },
): string {
  return `polling:${plan.reason}:${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`;
}

function startWebhookRecoveryTimer(
  orchestrator: ConductorOrchestrator,
  store: ConductorStore,
  logger: ConductorLogger,
): PollingController {
  const interval = globalThis.setInterval(() => {
    void processPendingWebhookDeliveries({
      store,
      orchestrator,
      logger,
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
    ready: Promise.resolve(),
    close() {
      globalThis.clearInterval(interval);
    },
  };
}

function jitteredIntervalMs(intervalSeconds: number): number {
  return Math.round(intervalSeconds * 1000 * (0.9 + Math.random() * 0.2));
}
