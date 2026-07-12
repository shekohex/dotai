import type { ResolvedRepositoryConfig } from "./config.js";
import { renderConductorComment } from "./follow-up.js";
import type { GitHubClient } from "./github.js";
import type { HerdrAgentStatus } from "./herdr.js";
import {
  commentRunBestEffort,
  runToWorkItem,
  updateProjectStatusBestEffort,
} from "./run-record.js";
import type { ConductorStore, RunRecord } from "./store/types.js";
import type { WorkflowFile } from "./workflow.js";

export const HERDR_BLOCKED_REASON = "Pi session needs operator input in Herdr";

export function isHerdrAttentionBlocked(run: RunRecord): boolean {
  return run.status === "blocked" && run.lastError === HERDR_BLOCKED_REASON;
}

export function activeStatusForRun(run: RunRecord): "in_progress" | "in_review" {
  return run.prNumber === undefined ? "in_progress" : "in_review";
}

export async function syncHerdrAttentionStatus(input: {
  agentStatus: HerdrAgentStatus | undefined;
  getRepo: () => Promise<{ config: ResolvedRepositoryConfig; workflow: WorkflowFile }>;
  github: GitHubClient;
  record: (run: RunRecord, kind: string, payload: unknown) => Promise<void>;
  run: RunRecord;
  store: ConductorStore;
  touch: (run: RunRecord) => RunRecord;
}): Promise<RunRecord> {
  if (input.agentStatus === undefined || input.agentStatus === "unknown") return input.run;
  if (input.agentStatus === "blocked") return blockForHerdrAttention(input);
  if (!isHerdrAttentionBlocked(input.run)) return input.run;

  const repo = await input.getRepo();
  const status = activeStatusForRun(input.run);
  const unblocked = input.touch({ ...input.run, status, lastError: undefined });
  await input.store.updateRun(unblocked);
  await updateProjectStatusBestEffort(
    input.github,
    repo.config,
    runToWorkItem(unblocked),
    status === "in_review"
      ? repo.config.statusOptions.in_review
      : repo.config.statusOptions.in_progress,
  );
  await input.record(unblocked, "unblocked", {
    reason: "herdr_agent_status",
    agentStatus: input.agentStatus,
  });
  return unblocked;
}

async function blockForHerdrAttention(input: {
  getRepo: () => Promise<{ config: ResolvedRepositoryConfig; workflow: WorkflowFile }>;
  github: GitHubClient;
  record: (run: RunRecord, kind: string, payload: unknown) => Promise<void>;
  run: RunRecord;
  store: ConductorStore;
  touch: (run: RunRecord) => RunRecord;
}): Promise<RunRecord> {
  if (isHerdrAttentionBlocked(input.run) || input.run.status === "blocked") return input.run;
  const repo = await input.getRepo();
  const blocked = input.touch({
    ...input.run,
    status: "blocked",
    lastError: HERDR_BLOCKED_REASON,
  });
  await input.store.updateRun(blocked);
  await updateProjectStatusBestEffort(
    input.github,
    repo.config,
    runToWorkItem(blocked),
    repo.config.statusOptions.blocked,
  );
  await commentRunBestEffort(
    input.github,
    blocked,
    renderConductorComment({
      config: repo.config,
      error: HERDR_BLOCKED_REASON,
      event: "runBlocked",
      run: blocked,
      workflow: repo.workflow,
    }),
  );
  await input.record(blocked, "blocked", { reason: "herdr_agent_blocked" });
  return blocked;
}
