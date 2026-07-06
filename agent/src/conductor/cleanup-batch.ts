import { errorMessage } from "../utils/error-message.js";
import type { ResolvedRepositoryConfig } from "./config.js";
import type { LifecycleStatus, RunRecord } from "./store/types.js";
import type { WorktreeManager } from "./worktree.js";

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
