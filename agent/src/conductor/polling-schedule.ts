import type { GlobalConductorConfig } from "./config.js";
import { projectConfigKey } from "./project-key.js";

export const DEFAULT_WEBHOOK_POLLING_INTERVAL_SECONDS = 15 * 60;
export const DEFAULT_WEBHOOK_PROJECT_SCAN_INTERVAL_SECONDS = 30 * 60;

export type PollingPlan = {
  activeRuns: boolean;
  intervalSeconds: number;
  projectScan: boolean;
  reason: string;
  repositories: Array<{ owner: string; repo: string }>;
};

export function createPollingPlans(config: GlobalConductorConfig): PollingPlan[] {
  const fallbackRepositories = config.repositories.filter(
    (repo) => !hasWebhookCoverage(config, repo),
  );
  const webhookRepositories = config.repositories.filter((repo) =>
    hasWebhookCoverage(config, repo),
  );
  const fallbackProjectRepositories: GlobalConductorConfig["repositories"] = [];
  const webhookProjectRepositories: GlobalConductorConfig["repositories"] = [];
  const projectGroups = new Map<string, GlobalConductorConfig["repositories"]>();
  for (const repo of config.repositories) {
    const key = projectConfigKey(repo.project);
    const group = projectGroups.get(key) ?? [];
    group.push(repo);
    projectGroups.set(key, group);
  }
  for (const group of projectGroups.values()) {
    const target = group.every((repo) => hasWebhookCoverage(config, repo))
      ? webhookProjectRepositories
      : fallbackProjectRepositories;
    target.push(...group);
  }

  return [
    pollingPlan(
      fallbackRepositories,
      config.pollingIntervalSeconds ?? 60,
      false,
      true,
      "polling-active-runs",
    ),
    pollingPlan(
      fallbackProjectRepositories,
      config.projectScanIntervalSeconds ?? config.pollingIntervalSeconds ?? 60,
      true,
      false,
      "polling-project-scan",
    ),
    pollingPlan(
      webhookRepositories,
      config.webhookPollingIntervalSeconds ?? DEFAULT_WEBHOOK_POLLING_INTERVAL_SECONDS,
      false,
      true,
      "webhook-safety-active-runs",
    ),
    pollingPlan(
      webhookProjectRepositories,
      config.webhookProjectScanIntervalSeconds ?? DEFAULT_WEBHOOK_PROJECT_SCAN_INTERVAL_SECONDS,
      true,
      false,
      "webhook-safety-project-scan",
    ),
  ].flatMap((plan) => (plan.repositories.length === 0 ? [] : [plan]));
}

function pollingPlan(
  repositories: GlobalConductorConfig["repositories"],
  intervalSeconds: number,
  projectScan: boolean,
  activeRuns: boolean,
  reason: string,
): PollingPlan {
  return {
    activeRuns,
    intervalSeconds,
    projectScan,
    reason,
    repositories: repositories.map((repo) => ({ owner: repo.owner, repo: repo.repo })),
  };
}

function hasWebhookCoverage(
  config: GlobalConductorConfig,
  repo: GlobalConductorConfig["repositories"][number],
): boolean {
  return config.webhook !== undefined && repo.webhookEnabled === true;
}
