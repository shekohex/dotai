import { join } from "node:path";
import { Value } from "typebox/value";

import { errorMessage } from "../utils/error-message.js";
import {
  type GlobalConductorConfig,
  type ManagedRepositoryConfig,
  type ResolvedRepositoryConfig,
  findManagedRepository,
  getStateRoot,
  resolveRepositoryConfig,
} from "./config.js";
import { cleanupMergedRunArtifacts, cleanupRunsByStatus } from "./cleanup-batch.js";
import { renderConductorComment, routePullRequestFeedback } from "./follow-up.js";
import type { PullRequestSummary } from "./github.js";
import {
  activeStatusForRun,
  HERDR_BLOCKED_REASON,
  isHerdrAttentionBlocked,
} from "./herdr-attention.js";
import {
  ReconcileScopeSchema,
  type ReconcileScope,
  scopeMatchesRepo,
  scopeMatchesRun,
  scopeMatchesWorkItem,
  scopePullRequestForRun,
  shouldScanProjectItems,
} from "./reconcile-scope.js";
import { buildRecoveryPromptContext } from "./recovery-context.js";
import {
  commentRunBestEffort,
  commentWorkItemBestEffort,
  runToPlan,
  runToWorkItem,
  sameRepository,
  updateProjectStatusBestEffort,
} from "./run-record.js";
import {
  assertGlobalConfigReady,
  dispatchAutomatedWorkItem,
  handleClosedWorkItem,
  hasMergedPullRequestForRun,
  hasRunStatusForWorkItem,
  isEligibleForAutomatedDispatch,
  isPullRequestMerged,
  type ConductorOrchestratorDeps,
  type RunOptions,
} from "./run-status.js";
import type { ConductorDeliveryMode, HerdrAgentStatus } from "./herdr.js";
import { selectLaunchFlags } from "./launch-rules.js";
import { appendRunLog } from "./logging.js";
import { renderInitialPrompt, writePromptArtifact } from "./prompt.js";
import { createRunId, slugify } from "./run-id.js";
import { RunRecordSchema, type RunRecord, type WorkItem } from "./store/types.js";
import { WorktreeManager, relativePromptPath } from "./worktree.js";
import { loadWorkflow, workflowConfigOverrides, type WorkflowFile } from "./workflow.js";

export type { ReconcileScope } from "./reconcile-scope.js";

export class ConductorOrchestrator {
  private readonly worktrees: WorktreeManager;
  private readonly stateRoot: string;
  private readonly now: () => Date;
  private reconcileQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ConductorOrchestratorDeps) {
    this.worktrees = deps.worktrees ?? new WorktreeManager();
    this.stateRoot = getStateRoot(deps.config);
    this.now = deps.now ?? (() => new Date());
  }

  updateConfig(config: GlobalConductorConfig): void {
    const nextStateRoot = getStateRoot(config);
    if (nextStateRoot !== this.stateRoot) {
      throw new Error("Changing conductor stateRoot requires restarting pi conductor serve");
    }
    this.deps.config = config;
  }

  async run(reference: string, options: RunOptions = {}): Promise<RunRecord> {
    assertGlobalConfigReady(this.deps.config);
    const workItem = await this.deps.github.resolveWorkItem(
      reference,
      this.deps.config,
      this.deps.cwd,
    );
    const repo = this.getManagedRepo(workItem.owner, workItem.repo);
    return this.dispatchWorkItem(repo, workItem, {
      manual: true,
      launchFlags: options.launchFlags ?? [],
      configOverrides: options.configOverrides ?? {},
    });
  }

  reconcile(scope?: ReconcileScope): Promise<RunRecord[]> {
    let validatedScope: ReconcileScope | undefined;
    if (scope !== undefined) validatedScope = Value.Parse(ReconcileScopeSchema, scope);
    const reconcile = this.reconcileQueue.then(() => this.reconcileOnce(validatedScope));
    this.reconcileQueue = reconcile.catch(() => {});
    return reconcile;
  }

  private async reconcileOnce(scope?: ReconcileScope): Promise<RunRecord[]> {
    assertGlobalConfigReady(this.deps.config);
    const dispatched: RunRecord[] = [];
    const login = await this.deps.github.getAuthenticatedUser();

    if (shouldScanProjectItems(scope)) {
      for (const repo of this.deps.config.repositories) {
        if (!scopeMatchesRepo(scope, repo)) continue;
        const runtime = await this.loadRepositoryRuntime(repo);
        const workItems = await this.deps.github.listProjectItems(runtime.config);
        for (const workItem of workItems) {
          if (!sameRepository(workItem, runtime.config)) continue;
          if (!scopeMatchesWorkItem(scope, workItem)) continue;
          if (
            await handleClosedWorkItem({
              blockRun: (run) => this.blockClosedIssueRun(runtime.config, run),
              isRunCompleted: (run) =>
                hasMergedPullRequestForRun({ github: this.deps.github, run }),
              store: this.deps.store,
              workItem,
            })
          )
            continue;
          if (!isEligibleForAutomatedDispatch(workItem, runtime.config.dispatchLabel, login))
            continue;
          const active = await this.deps.store.getActiveRun(
            workItem.owner,
            workItem.repo,
            workItem.issueNumber,
          );
          if (active !== undefined) continue;
          if (await hasRunStatusForWorkItem(this.deps.store, workItem, "blocked")) continue;
          if (await hasRunStatusForWorkItem(this.deps.store, workItem, "done")) continue;
          try {
            dispatched.push(
              ...(await dispatchAutomatedWorkItem({
                config: runtime.config,
                dispatch: () =>
                  this.dispatchWorkItem(repo, workItem, { manual: false, launchFlags: [] }),
                github: this.deps.github,
                workItem,
                worktrees: this.worktrees,
              })),
            );
          } catch {
            continue;
          }
        }
      }
    }

    await this.reconcileActiveRuns(login, scope);
    return dispatched;
  }

  async send(runId: string, message: string, delivery: ConductorDeliveryMode): Promise<RunRecord> {
    const run = await this.ensureRunSession(await this.getRunOrThrow(runId));
    await this.record(run, "send_pending", { delivery, message });
    try {
      await this.deps.herdr.send(run.herdr, message, delivery);
      const updated = this.touch(run);
      await this.deps.store.updateRun(updated);
      await this.record(updated, "send", { delivery, message });
      return updated;
    } catch (error) {
      await this.record(run, "send_failed", { delivery, message, error: errorMessage(error) });
      throw error;
    }
  }

  async pause(runId: string): Promise<RunRecord> {
    const run = await this.getRunOrThrow(runId);
    const updated = this.touch({ ...run, paused: true });
    await this.deps.store.updateRun(updated);
    await this.record(updated, "pause", {});
    return updated;
  }

  async resume(runId: string): Promise<RunRecord> {
    const run = await this.getRunOrThrow(runId);
    const status = isHerdrAttentionBlocked(run) ? activeStatusForRun(run) : run.status;
    const updated = this.touch({ ...run, paused: false, status, lastError: undefined });
    await this.deps.store.updateRun(updated);
    await this.record(updated, "resume", {});
    return updated;
  }

  async stop(runId: string): Promise<RunRecord> {
    const run = await this.getRunOrThrow(runId);
    const repo = await this.getResolvedRepo(run.owner, run.repo);
    await this.deps.herdr.stop(run.herdr);
    await this.worktrees.cleanupLocal(repo.config, runToPlan(run));
    const updated = this.touch({ ...run, status: "blocked", paused: false });
    await this.deps.store.updateRun(updated);
    await this.deps.github.updateProjectStatus(
      repo.config,
      runToWorkItem(run),
      repo.config.statusOptions.blocked,
    );
    await commentWorkItemBestEffort(
      this.deps.github,
      runToWorkItem(run),
      renderConductorComment({
        config: repo.config,
        event: "runStopped",
        run: updated,
        workflow: repo.workflow,
      }),
    );
    await this.record(updated, "stop", {});
    return updated;
  }

  async retry(runId: string): Promise<RunRecord> {
    const run = await this.getRunOrThrow(runId);
    if (run.status === "done") throw new Error(`Cannot retry completed run: ${run.runId}`);
    const repoConfig = this.getManagedRepo(run.owner, run.repo);
    const runtime = await this.loadRepositoryRuntime(repoConfig);
    const workItem = await this.deps.github.resolveWorkItem(
      `${run.owner}/${run.repo}#${run.issueNumber}`,
      this.deps.config,
      this.deps.cwd,
    );
    const plan = runToPlan(run);
    try {
      await this.deps.herdr.stop(run.herdr);
      await this.worktrees.prepare(runtime.config, plan);
      const prompt = renderInitialPrompt({
        config: runtime.config,
        workflow: runtime.workflow,
        workItem,
        plan,
        runId: run.runId,
        attempt: run.attempt + 1,
        recovery: true,
        recoveryContext: await buildRecoveryPromptContext({
          github: this.deps.github,
          run,
          store: this.deps.store,
        }),
      });
      const promptArtifact = await writePromptArtifact(plan.worktreePath, prompt);
      const herdr = await this.deps.herdr.launch({
        owner: run.owner,
        repo: run.repo,
        issueNumber: run.issueNumber,
        slug: slugify(run.issueTitle),
        repoPath: runtime.config.repoPath,
        worktreePath: plan.worktreePath,
        launchFlags: run.launchFlags,
        promptRelativePath: promptArtifact.promptRelativePath,
      });
      const updated = this.touch({
        ...run,
        status: "in_progress",
        paused: false,
        attempt: run.attempt + 1,
        promptPath: promptArtifact.promptPath,
        herdr,
        lastError: undefined,
      });
      await this.deps.store.updateRun(updated);
      await this.record(updated, "retry", { attempt: updated.attempt });
      return updated;
    } catch (error) {
      const blocked = this.touch({ ...run, status: "blocked", lastError: errorMessage(error) });
      await this.deps.store.updateRun(blocked);
      await this.record(blocked, "retry_failed", { error: errorMessage(error) });
      throw error;
    }
  }

  async cleanup(runId: string, merged: boolean): Promise<RunRecord> {
    const run = await this.getRunOrThrow(runId);
    const repo = await this.getResolvedRepo(run.owner, run.repo);
    if (merged) {
      if (run.status !== "done") {
        throw new Error(`Merged cleanup requires a completed merged run: ${run.runId}`);
      }
      await this.worktrees.cleanupMerged(repo.config, runToPlan(run));
    } else {
      await this.worktrees.cleanupLocal(repo.config, runToPlan(run));
    }
    const updated = this.touch(
      merged || run.status === "done" ? run : { ...run, status: "blocked" },
    );
    await this.deps.store.updateRun(updated);
    await this.record(updated, "cleanup", { merged });
    return updated;
  }

  async cleanupMergedRuns(): Promise<RunRecord[]> {
    return cleanupRunsByStatus({
      runs: await this.deps.store.listRuns(),
      status: "done",
      cleanup: (run) => this.cleanup(run.runId, true),
      recordFailure: (run, payload) =>
        this.record(run, "cleanup_failed", { ...payload, merged: true }),
    });
  }

  async cleanupFailedRuns(): Promise<RunRecord[]> {
    return cleanupRunsByStatus({
      runs: await this.deps.store.listRuns(),
      status: "blocked",
      cleanup: (run) => this.cleanup(run.runId, false),
      recordFailure: (run, payload) =>
        this.record(run, "cleanup_failed", { ...payload, failed: true }),
    });
  }

  private async blockClosedIssueRun(
    config: ResolvedRepositoryConfig,
    run: RunRecord,
  ): Promise<void> {
    const blocked = this.touch({ ...run, status: "blocked", lastError: "Issue is closed" });
    await this.deps.store.updateRun(blocked);
    try {
      await this.deps.herdr.stop(run.herdr);
      await this.record(blocked, "herdr_stopped", { herdr: run.herdr, reason: "issue_closed" });
    } catch (error) {
      await this.record(blocked, "herdr_stop_failed", { error: errorMessage(error) });
    }
    const status = config.statusOptions.blocked;
    await updateProjectStatusBestEffort(this.deps.github, config, runToWorkItem(blocked), status);
    await this.record(blocked, "blocked", { reason: "issue_closed" });
  }

  private async dispatchWorkItem(
    repo: ManagedRepositoryConfig,
    workItem: WorkItem,
    options: {
      manual: boolean;
      launchFlags: string[];
      configOverrides?: Partial<ManagedRepositoryConfig>;
    },
  ): Promise<RunRecord> {
    const runtime = await this.loadRepositoryRuntime(repo, options.configOverrides ?? {});
    if (!sameRepository(workItem, runtime.config)) {
      throw new Error(
        `Work item ${workItem.owner}/${workItem.repo}#${workItem.issueNumber} does not belong to managed repository ${runtime.config.owner}/${runtime.config.repo}`,
      );
    }
    const repository = await this.deps.github.getRepository(repo.owner, repo.repo);
    const plan = this.worktrees.plan(runtime.config, workItem, repository.defaultBranch);
    const active = await this.deps.store.getActiveRun(
      workItem.owner,
      workItem.repo,
      workItem.issueNumber,
    );
    if (active !== undefined) throw new Error(`Active run already exists: ${active.runId}`);

    const runId = createRunId({
      owner: workItem.owner,
      repo: workItem.repo,
      issueNumber: workItem.issueNumber,
    });
    const launchFlags =
      options.launchFlags.length > 0
        ? options.launchFlags
        : selectLaunchFlags(runtime.workflow, runtime.config, workItem, plan, runId);
    const createdAt = this.nowIso();
    const run = Value.Parse(RunRecordSchema, {
      runId,
      owner: workItem.owner,
      repo: workItem.repo,
      issueNumber: workItem.issueNumber,
      issueUrl: workItem.issueUrl,
      issueTitle: workItem.title,
      projectItemId: workItem.projectItemId,
      projectId: workItem.projectId,
      status: "in_progress",
      paused: false,
      attempt: 1,
      branch: plan.branch,
      baseRef: plan.baseRef,
      worktreePath: plan.worktreePath,
      promptPath: join(plan.worktreePath, relativePromptPath()),
      launchFlags,
      herdr: {},
      routedFeedbackKeys: [],
      createdAt,
      updatedAt: createdAt,
    });

    try {
      await this.deps.store.createRun(run);
    } catch (error) {
      const existing = await this.deps.store.getActiveRun(
        workItem.owner,
        workItem.repo,
        workItem.issueNumber,
      );
      if (existing !== undefined)
        throw new Error(`Active run already exists: ${existing.runId}`, { cause: error });
      throw error;
    }
    await this.record(run, "create", { manual: options.manual });

    try {
      await this.deps.github.updateProjectStatus(
        runtime.config,
        workItem,
        runtime.config.statusOptions.in_progress,
      );
      await this.worktrees.prepare(runtime.config, plan);
      const prompt = renderInitialPrompt({
        config: runtime.config,
        workflow: runtime.workflow,
        workItem,
        plan,
        runId,
        attempt: 1,
      });
      const promptArtifact = await writePromptArtifact(plan.worktreePath, prompt);
      const herdr = await this.deps.herdr.launch({
        owner: workItem.owner,
        repo: workItem.repo,
        issueNumber: workItem.issueNumber,
        slug: plan.slug,
        repoPath: runtime.config.repoPath,
        worktreePath: plan.worktreePath,
        launchFlags,
        promptRelativePath: promptArtifact.promptRelativePath,
      });
      const updated = this.touch({ ...run, promptPath: promptArtifact.promptPath, herdr });
      await this.deps.store.updateRun(updated);
      await this.record(updated, "launch", { herdr });
      return updated;
    } catch (error) {
      const blocked = this.touch({
        ...run,
        status: "blocked",
        lastError: errorMessage(error),
      });
      await this.deps.store.updateRun(blocked);
      await updateProjectStatusBestEffort(
        this.deps.github,
        runtime.config,
        workItem,
        runtime.config.statusOptions.blocked,
      );
      await commentWorkItemBestEffort(
        this.deps.github,
        workItem,
        renderConductorComment({
          config: runtime.config,
          error: blocked.lastError ?? "unknown",
          event: "runBlocked",
          run: blocked,
          workflow: runtime.workflow,
        }),
      );
      await this.record(blocked, "error", { message: blocked.lastError });
      throw error;
    }
  }

  private async reconcileActiveRuns(
    authenticatedLogin: string,
    scope: ReconcileScope | undefined,
  ): Promise<void> {
    for (const run of await this.deps.store.listRuns()) {
      try {
        if (run.paused || run.status === "done") continue;
        if (run.status === "blocked" && !isHerdrAttentionBlocked(run)) continue;
        if (!scopeMatchesRun(scope, run)) continue;
        const liveRun = await this.syncHerdrAgentStatus(await this.ensureRunSession(run));
        const pr =
          scopePullRequestForRun(scope, liveRun) ??
          (await this.deps.github.findPullRequestByBranch(
            liveRun.owner,
            liveRun.repo,
            liveRun.branch,
          ));
        if (pr === undefined) continue;
        const updated = await this.reconcilePullRequest(liveRun, pr);
        await this.routeFeedbackForRun(updated, pr, authenticatedLogin);
      } catch (error) {
        await this.record(run, "reconcile_run_failed", { error: errorMessage(error) });
      }
    }
  }

  private routeFeedbackForRun(
    run: RunRecord,
    pr: PullRequestSummary,
    authenticatedLogin: string,
  ): Promise<RunRecord> {
    return routePullRequestFeedback({
      authenticatedLogin,
      ensureRunSession: (record) => this.ensureRunSession(record),
      getResolvedRepo: (owner, repo) => this.getResolvedRepo(owner, repo),
      github: this.deps.github,
      herdr: this.deps.herdr,
      pr,
      record: (record, kind, payload) => this.record(record, kind, payload),
      run,
      touch: (record) => this.touch(record),
      updateRun: (record) => this.deps.store.updateRun(record),
    });
  }

  private async reconcilePullRequest(run: RunRecord, pr: PullRequestSummary): Promise<RunRecord> {
    const repo = await this.getResolvedRepo(run.owner, run.repo);
    if (
      pr.linkedIssueNumbers !== undefined &&
      pr.linkedIssueNumbers.length > 0 &&
      !pr.linkedIssueNumbers.includes(run.issueNumber)
    ) {
      await this.record(run, "pr_ignored", {
        prUrl: pr.url,
        reason: "linked_issue_mismatch",
        linkedIssueNumbers: pr.linkedIssueNumbers,
      });
      return run;
    }
    if (isPullRequestMerged(pr)) {
      const done = this.touch({ ...run, status: "done", prNumber: pr.number, prUrl: pr.url });
      await cleanupMergedRunArtifacts({
        config: repo.config,
        herdr: this.deps.herdr,
        plan: runToPlan(done),
        record: (kind, payload) => this.record(done, kind, payload),
        run: done,
        worktrees: this.worktrees,
      });
      await this.deps.store.updateRun(done);
      await updateProjectStatusBestEffort(
        this.deps.github,
        repo.config,
        runToWorkItem(done),
        repo.config.statusOptions.done,
      );
      await commentWorkItemBestEffort(
        this.deps.github,
        runToWorkItem(done),
        renderConductorComment({
          config: repo.config,
          event: "runCompleted",
          pr,
          run: done,
          workflow: repo.workflow,
        }),
      );
      await this.record(done, "done", { prUrl: pr.url });
      return done;
    }

    if (pr.state.toUpperCase() === "CLOSED") {
      const blocked = this.touch({
        ...run,
        status: "blocked",
        prNumber: pr.number,
        prUrl: pr.url,
        lastError: "Associated PR closed without merge",
      });
      await this.deps.store.updateRun(blocked);
      await this.deps.github.updateProjectStatus(
        repo.config,
        runToWorkItem(blocked),
        repo.config.statusOptions.blocked,
      );
      await commentRunBestEffort(
        this.deps.github,
        blocked,
        renderConductorComment({
          config: repo.config,
          error: `PR closed without merge (${pr.url})`,
          event: "runBlocked",
          pr,
          run: blocked,
          workflow: repo.workflow,
        }),
      );
      await this.record(blocked, "blocked", { prUrl: pr.url, reason: "pr_closed" });
      return blocked;
    }

    if (isHerdrAttentionBlocked(run)) {
      if (run.prUrl === pr.url && run.prNumber === pr.number) return run;
      const associated = this.touch({ ...run, prNumber: pr.number, prUrl: pr.url });
      await this.deps.store.updateRun(associated);
      await this.record(associated, "pr_associated", { prUrl: pr.url });
      return associated;
    }

    if (run.prUrl === pr.url && run.status === "in_review" && run.prNumber === pr.number) {
      return run;
    }
    const inReview = this.touch({
      ...run,
      status: "in_review",
      prNumber: pr.number,
      prUrl: pr.url,
    });
    await this.deps.store.updateRun(inReview);
    await this.deps.github.updateProjectStatus(
      repo.config,
      runToWorkItem(inReview),
      repo.config.statusOptions.in_review,
    );
    if (run.prUrl === undefined) {
      await commentWorkItemBestEffort(
        this.deps.github,
        runToWorkItem(inReview),
        renderConductorComment({
          config: repo.config,
          event: "prAssociated",
          pr,
          run: inReview,
          workflow: repo.workflow,
        }),
      );
    }
    await this.record(inReview, "pr_associated", { prUrl: pr.url });
    return inReview;
  }

  private async ensureRunSession(run: RunRecord): Promise<RunRecord> {
    if (await this.deps.herdr.paneExists(run.herdr)) return run;

    const location = await this.deps.herdr.find({
      owner: run.owner,
      repo: run.repo,
      issueNumber: run.issueNumber,
      slug: slugify(run.issueTitle),
    });
    if (location?.paneId !== undefined) {
      const rediscovered = this.touch({ ...run, herdr: location });
      await this.deps.store.updateRun(rediscovered);
      await this.record(rediscovered, "herdr_rediscovered", { herdr: location });
      return rediscovered;
    }

    return this.relaunchMissingSession(run);
  }

  private async relaunchMissingSession(run: RunRecord): Promise<RunRecord> {
    const runtime = await this.getResolvedRepo(run.owner, run.repo);
    const workItem = await this.deps.github.resolveWorkItem(
      `${run.owner}/${run.repo}#${run.issueNumber}`,
      this.deps.config,
      this.deps.cwd,
    );
    const plan = runToPlan(run);
    await this.worktrees.prepare(runtime.config, plan);
    const prompt = renderInitialPrompt({
      config: runtime.config,
      workflow: runtime.workflow,
      workItem,
      plan,
      runId: run.runId,
      attempt: run.attempt,
      recovery: true,
      recoveryContext: await buildRecoveryPromptContext({
        github: this.deps.github,
        run,
        store: this.deps.store,
      }),
    });
    const promptArtifact = await writePromptArtifact(plan.worktreePath, prompt);
    const herdr = await this.deps.herdr.launch({
      owner: run.owner,
      repo: run.repo,
      issueNumber: run.issueNumber,
      slug: slugify(run.issueTitle),
      repoPath: runtime.config.repoPath,
      worktreePath: run.worktreePath,
      launchFlags: run.launchFlags,
      promptRelativePath: promptArtifact.promptRelativePath,
    });
    const recovered = this.touch({ ...run, promptPath: promptArtifact.promptPath, herdr });
    await this.deps.store.updateRun(recovered);
    await this.record(recovered, "herdr_recovered", { herdr });
    return recovered;
  }
  private async syncHerdrAgentStatus(run: RunRecord): Promise<RunRecord> {
    const status = await this.deps.herdr.agentStatus(run.herdr);
    if (status === undefined || status === "unknown") return run;
    if (status === "blocked") return this.blockForHerdrAttention(run);
    if (isHerdrAttentionBlocked(run)) return this.unblockFromHerdrAttention(run, status);
    return run;
  }
  private async blockForHerdrAttention(run: RunRecord): Promise<RunRecord> {
    if (isHerdrAttentionBlocked(run) || run.status === "blocked") return run;
    const repo = await this.getResolvedRepo(run.owner, run.repo);
    const blocked = this.touch({ ...run, status: "blocked", lastError: HERDR_BLOCKED_REASON });
    await this.deps.store.updateRun(blocked);
    await updateProjectStatusBestEffort(
      this.deps.github,
      repo.config,
      runToWorkItem(blocked),
      repo.config.statusOptions.blocked,
    );
    await commentRunBestEffort(
      this.deps.github,
      blocked,
      renderConductorComment({
        config: repo.config,
        error: HERDR_BLOCKED_REASON,
        event: "runBlocked",
        run: blocked,
        workflow: repo.workflow,
      }),
    );
    await this.record(blocked, "blocked", { reason: "herdr_agent_blocked" });
    return blocked;
  }
  private async unblockFromHerdrAttention(
    run: RunRecord,
    agentStatus: Exclude<HerdrAgentStatus, "blocked" | "unknown">,
  ): Promise<RunRecord> {
    const repo = await this.getResolvedRepo(run.owner, run.repo);
    const status = run.prNumber === undefined ? "in_progress" : "in_review";
    const unblocked = this.touch({ ...run, status, lastError: undefined });
    await this.deps.store.updateRun(unblocked);
    await updateProjectStatusBestEffort(
      this.deps.github,
      repo.config,
      runToWorkItem(unblocked),
      status === "in_review"
        ? repo.config.statusOptions.in_review
        : repo.config.statusOptions.in_progress,
    );
    await this.record(unblocked, "unblocked", { reason: "herdr_agent_status", agentStatus });
    return unblocked;
  }
  private async loadRepositoryRuntime(
    repo: ManagedRepositoryConfig,
    cliOverrides: Partial<ManagedRepositoryConfig> = {},
  ): Promise<{
    workflow: WorkflowFile;
    config: ResolvedRepositoryConfig;
  }> {
    const workflow = await loadWorkflow(repo.repoPath);
    const config = resolveRepositoryConfig(
      repo,
      workflowConfigOverrides(workflow),
      cliOverrides,
      this.stateRoot,
    );
    return { workflow, config };
  }
  private async getResolvedRepo(
    owner: string,
    repo: string,
  ): Promise<{
    repo: ManagedRepositoryConfig;
    workflow: WorkflowFile;
    config: ResolvedRepositoryConfig;
  }> {
    const managed = this.getManagedRepo(owner, repo);
    const runtime = await this.loadRepositoryRuntime(managed);
    return { repo: managed, workflow: runtime.workflow, config: runtime.config };
  }
  private getManagedRepo(owner: string, repo: string): ManagedRepositoryConfig {
    const managed = findManagedRepository(this.deps.config, owner, repo);
    if (managed === undefined) throw new Error(`${owner}/${repo} is not managed by conductor`);
    return managed;
  }
  private async getRunOrThrow(runId: string): Promise<RunRecord> {
    const run = await this.deps.store.getRun(runId);
    if (run === undefined) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  private touch(run: RunRecord): RunRecord {
    return Value.Parse(RunRecordSchema, { ...run, updatedAt: this.nowIso() });
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private async record(run: RunRecord, kind: string, payload: unknown): Promise<void> {
    const createdAt = this.nowIso();
    await this.deps.store.appendEvent({ runId: run.runId, kind, payload, createdAt });
    try {
      await appendRunLog(this.stateRoot, { runId: run.runId, kind, payload, createdAt });
    } catch {}
  }
}
