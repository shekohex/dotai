import { errorMessage } from "../utils/error-message.js";
import type { ResolvedRepositoryConfig } from "./config.js";
import type { HerdrSessionManager } from "./herdr.js";
import type { LifecycleStatus, RunRecord } from "./store/types.js";
import type { WorktreeManager, WorktreePlan } from "./worktree.js";

export async function cleanupRunsByStatus(input: {
  runs: RunRecord[];
  status: LifecycleStatus;
  cleanup: (run: RunRecord) => Promise<RunRecord>;
  recordFailure: (run: RunRecord, payload: { error: string }) => Promise<void>;
}): Promise<RunRecord[]> {
  const cleaned: RunRecord[] = [];
  for (const run of input.runs) {
    if (run.status !== input.status) continue;
    try {
      cleaned.push(await input.cleanup(run));
    } catch (error) {
      await input.recordFailure(run, { error: errorMessage(error) });
    }
  }
  return cleaned;
}

export async function refreshLocalBaseBestEffort(input: {
  config: ResolvedRepositoryConfig;
  record: (kind: string, payload: unknown) => Promise<void>;
  run: RunRecord;
  worktrees: WorktreeManager;
}): Promise<void> {
  try {
    await input.record(
      "base_refresh",
      await input.worktrees.refreshLocalBase(input.config, input.run.baseRef),
    );
  } catch (error) {
    await input.record("base_refresh_failed", {
      error: errorMessage(error),
      baseRef: input.run.baseRef,
    });
  }
}

export async function cleanupMergedRunArtifacts(input: {
  config: ResolvedRepositoryConfig;
  herdr: HerdrSessionManager;
  plan: Pick<WorktreePlan, "worktreePath" | "branch">;
  record: (kind: string, payload: unknown) => Promise<void>;
  run: RunRecord;
  worktrees: WorktreeManager;
}): Promise<void> {
  await input.record("cleanup_merged_started", {
    branch: input.plan.branch,
    worktreePath: input.plan.worktreePath,
  });
  try {
    await input.herdr.stop(input.run.herdr);
    await input.record("herdr_stopped", { herdr: input.run.herdr });
  } catch (error) {
    await input.record("herdr_stop_failed", { error: errorMessage(error) });
  }
  try {
    await input.worktrees.cleanupMerged(input.config, input.plan);
    await input.record("cleanup_merged_artifacts", {
      branch: input.plan.branch,
      worktreePath: input.plan.worktreePath,
    });
  } catch (error) {
    await input.record("cleanup_merged_failed", {
      branch: input.plan.branch,
      error: errorMessage(error),
      worktreePath: input.plan.worktreePath,
    });
    throw error;
  }
  await refreshLocalBaseBestEffort({
    config: input.config,
    record: input.record,
    run: input.run,
    worktrees: input.worktrees,
  });
}
