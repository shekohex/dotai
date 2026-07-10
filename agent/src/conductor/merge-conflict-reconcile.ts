import type { ResolvedRepositoryConfig } from "./config.js";
import { routePullRequestFeedback } from "./follow-up.js";
import type { GitHubClient, PullRequestSummary } from "./github.js";
import type { PullRequestFeedback } from "./github-feedback.js";
import type { ConductorDeliveryMode } from "./herdr.js";
import {
  createMergeConflictEpisode,
  isMergeConflictStateKnown,
  mergeConflictFeedback,
} from "./merge-conflict-feedback.js";
import { runToWorkItem, updateProjectStatusBestEffort } from "./run-record.js";
import type { ConductorStore, HerdrHandles, LifecycleStatus, RunRecord } from "./store/types.js";
import type { WorkflowFile } from "./workflow.js";

export async function reconcileMergeConflict(input: {
  authenticatedLogin: string;
  attentionBlocked: boolean;
  ensureRunSession(run: RunRecord): Promise<RunRecord>;
  feedback?: PullRequestFeedback[];
  getResolvedRepo(
    owner: string,
    repo: string,
  ): Promise<{ config: ResolvedRepositoryConfig; workflow: WorkflowFile }>;
  github: GitHubClient;
  herdr: {
    send(handles: HerdrHandles, message: string, delivery: ConductorDeliveryMode): Promise<void>;
  };
  now: () => Date;
  pr: PullRequestSummary;
  record(run: RunRecord, kind: string, payload: unknown): Promise<void>;
  run: RunRecord;
  store: ConductorStore;
  touch(run: RunRecord): RunRecord;
}): Promise<RunRecord> {
  const runtime = await input.getResolvedRepo(input.run.owner, input.run.repo);
  const route = (run: RunRecord, feedback?: PullRequestFeedback[]): Promise<RunRecord> =>
    routePullRequestFeedback({
      authenticatedLogin: input.authenticatedLogin,
      ensureRunSession: (record) => input.ensureRunSession(record),
      getResolvedRepo: () => Promise.resolve(runtime),
      github: input.github,
      herdr: input.herdr,
      pr: input.pr,
      ...(feedback === undefined ? {} : { feedback }),
      record: (record, kind, payload) => input.record(record, kind, payload),
      run,
      touch: (record) => input.touch(record),
      updateRun: (record) => input.store.updateRun(record),
    });
  const regularFeedback = input.feedback?.filter((item) => item.kind !== "merge_conflict");
  const detectedStatus: LifecycleStatus = input.attentionBlocked ? "blocked" : "in_progress";
  const resolvedStatus: LifecycleStatus = input.attentionBlocked ? "blocked" : "in_review";
  const episode = createMergeConflictEpisode(input.pr, input.now().toISOString());
  if (episode !== undefined && input.run.mergeConflict?.fingerprint !== episode.fingerprint) {
    const candidate = input.touch({
      ...input.run,
      status: detectedStatus,
      mergeConflict: episode,
    });
    const routed = await route(candidate, [
      ...mergeConflictFeedback(input.pr, episode),
      ...(regularFeedback ?? []),
    ]);
    await updateProjectStatusBestEffort(
      input.github,
      runtime.config,
      runToWorkItem(routed),
      input.attentionBlocked
        ? runtime.config.statusOptions.blocked
        : runtime.config.statusOptions.in_progress,
    );
    await input.record(routed, "merge_conflict_detected", episode);
    return routed;
  }
  if (
    episode === undefined &&
    input.run.mergeConflict !== undefined &&
    isMergeConflictStateKnown(input.pr)
  ) {
    const { mergeConflict, ...withoutConflict } = input.run;
    const routedFeedbackKeys = (input.run.routedFeedbackKeys ?? []).filter(
      (key) => !key.startsWith(`merge-conflict:${input.pr.number}:`),
    );
    const resolved = input.touch({
      ...withoutConflict,
      status: resolvedStatus,
      routedFeedbackKeys,
    });
    await input.store.updateRun(resolved);
    await updateProjectStatusBestEffort(
      input.github,
      runtime.config,
      runToWorkItem(resolved),
      input.attentionBlocked
        ? runtime.config.statusOptions.blocked
        : runtime.config.statusOptions.in_review,
    );
    await input.record(resolved, "merge_conflict_resolved", {
      fingerprint: mergeConflict.fingerprint,
    });
    return route(resolved, regularFeedback);
  }
  return route(input.run, regularFeedback);
}
