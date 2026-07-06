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
  validateGlobalConfig,
} from "./config.js";
import { evaluateCondition } from "./expression.js";
import type { GitHubClient, PullRequestSummary } from "./github.js";
import {
  ReconcileScopeSchema,
  type ReconcileScope,
  scopeMatchesRepo,
  scopeMatchesRun,
  scopeMatchesWorkItem,
  scopePullRequestForRun,
  shouldScanProjectItems,
} from "./reconcile-scope.js";
import type { ConductorDeliveryMode, HerdrSessionManager } from "./herdr.js";
import { appendRunLog } from "./logging.js";
import {
  buildExpressionContext,
  renderInitialPrompt,
  type RecoveryPromptFeedback,
  writePromptArtifact,
} from "./prompt.js";
import { createRunId, slugify } from "./run-id.js";
import { RunRecordSchema, type RunRecord, type WorkItem } from "./store/types.js";
import type { ConductorStore } from "./store/types.js";
import { type WorktreePlan, WorktreeManager, relativePromptPath } from "./worktree.js";
import { loadWorkflow, workflowConfigOverrides, type WorkflowFile } from "./workflow.js";

export type ConductorOrchestratorDeps = {
  config: GlobalConductorConfig;
  store: ConductorStore;
  github: GitHubClient;
  herdr: HerdrSessionManager;
  worktrees?: WorktreeManager;
  cwd: string;
  now?: () => Date;
};

export type RunOptions = {
  launchFlags?: string[];
  configOverrides?: Partial<ManagedRepositoryConfig>;
};

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
    this.assertConfigReady();
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
    this.assertConfigReady();
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
          if (!isEligibleForAutomatedDispatch(workItem, runtime.config.dispatchLabel, login))
            continue;
          const active = await this.deps.store.getActiveRun(
            workItem.owner,
            workItem.repo,
            workItem.issueNumber,
          );
          if (active !== undefined) continue;
          if (await this.hasBlockedRun(workItem)) continue;
          try {
            dispatched.push(
              await this.dispatchWorkItem(repo, workItem, { manual: false, launchFlags: [] }),
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
    const updated = this.touch({ ...run, paused: false });
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
    await this.deps.github.commentIssue(
      runToWorkItem(run),
      `Pi Conductor stopped run ${run.runId}.`,
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
        recoveryContext: await this.buildRecoveryPromptContext(run),
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
    const updated = this.touch(merged ? run : { ...run, status: "blocked" });
    await this.deps.store.updateRun(updated);
    await this.record(updated, "cleanup", { merged });
    return updated;
  }

  async cleanupMergedRuns(): Promise<RunRecord[]> {
    const cleaned: RunRecord[] = [];
    for (const run of await this.deps.store.listRuns()) {
      if (run.status !== "done") continue;
      try {
        cleaned.push(await this.cleanup(run.runId, true));
      } catch (error) {
        await this.record(run, "cleanup_failed", { error: errorMessage(error), merged: true });
      }
    }
    return cleaned;
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
      await this.updateProjectStatusBestEffort(
        runtime.config,
        workItem,
        runtime.config.statusOptions.blocked,
      );
      await this.commentBestEffort(
        workItem,
        `Pi Conductor blocked run ${run.runId}.\n\nError: ${blocked.lastError ?? "unknown"}`,
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
        if (run.paused || run.status === "done" || run.status === "blocked") continue;
        if (!scopeMatchesRun(scope, run)) continue;
        const liveRun = await this.ensureRunSession(run);
        const pr =
          scopePullRequestForRun(scope, liveRun) ??
          (await this.deps.github.findPullRequestByBranch(
            liveRun.owner,
            liveRun.repo,
            liveRun.branch,
          ));
        if (pr === undefined) continue;
        const updated = await this.reconcilePullRequest(liveRun, pr);
        await this.routePullRequestFeedback(updated, authenticatedLogin);
      } catch (error) {
        await this.record(run, "reconcile_run_failed", { error: errorMessage(error) });
      }
    }
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
    if (pr.mergedAt !== undefined) {
      const done = this.touch({ ...run, status: "done", prNumber: pr.number, prUrl: pr.url });
      await this.worktrees.cleanupMerged(repo.config, runToPlan(done));
      await this.deps.store.updateRun(done);
      await this.updateProjectStatusBestEffort(
        repo.config,
        runToWorkItem(done),
        repo.config.statusOptions.done,
      );
      await this.commentBestEffort(
        runToWorkItem(done),
        `Pi Conductor completed run ${done.runId}: ${pr.url}`,
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
      await this.deps.github.commentIssue(
        runToWorkItem(blocked),
        `Pi Conductor blocked run ${blocked.runId}: PR closed without merge (${pr.url}).`,
      );
      await this.record(blocked, "blocked", { prUrl: pr.url, reason: "pr_closed" });
      return blocked;
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
      await this.deps.github.commentIssue(
        runToWorkItem(inReview),
        `Pi Conductor associated PR: ${pr.url}`,
      );
    }
    await this.record(inReview, "pr_associated", { prUrl: pr.url });
    return inReview;
  }

  private async routePullRequestFeedback(
    run: RunRecord,
    authenticatedLogin: string,
  ): Promise<RunRecord> {
    if (run.prNumber === undefined || run.status === "done" || run.paused) return run;
    const knownKeys = new Set(run.routedFeedbackKeys ?? []);
    const feedback = await this.deps.github.listPullRequestFeedback(
      run.owner,
      run.repo,
      run.prNumber,
      run.issueNumber,
      [authenticatedLogin],
    );
    let updated = run;
    for (const item of feedback) {
      if (knownKeys.has(item.key)) continue;
      updated = await this.ensureRunSession(updated);
      await this.deps.herdr.send(updated.herdr, formatPullRequestFeedback(item), "followUp");
      knownKeys.add(item.key);
      updated = this.touch({ ...updated, routedFeedbackKeys: [...knownKeys] });
      await this.deps.store.updateRun(updated);
      await this.record(updated, "feedback_routed", {
        key: item.key,
        kind: item.kind,
        url: item.url,
      });
    }
    return updated;
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
      recoveryContext: await this.buildRecoveryPromptContext(run),
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

  private async commentBestEffort(workItem: WorkItem, body: string): Promise<void> {
    try {
      await this.deps.github.commentIssue(workItem, body);
    } catch {}
  }

  private async updateProjectStatusBestEffort(
    repo: ManagedRepositoryConfig,
    workItem: WorkItem,
    statusName: string,
  ): Promise<void> {
    try {
      await this.deps.github.updateProjectStatus(repo, workItem, statusName);
    } catch {}
  }

  private async hasBlockedRun(workItem: WorkItem): Promise<boolean> {
    return (await this.deps.store.listRuns()).some(
      (run) =>
        run.owner === workItem.owner &&
        run.repo === workItem.repo &&
        run.issueNumber === workItem.issueNumber &&
        run.status === "blocked",
    );
  }

  private async buildRecoveryPromptContext(run: RunRecord): Promise<{
    run: RunRecord;
    feedback: RecoveryPromptFeedback[];
    events: Array<{ kind: string; createdAt: string }>;
  }> {
    return {
      run,
      feedback: await this.readRecoveryFeedback(run),
      events: (await this.deps.store.listEvents(run.runId, 10)).map((event) => ({
        kind: event.kind,
        createdAt: event.createdAt,
      })),
    };
  }

  private async readRecoveryFeedback(run: RunRecord): Promise<RecoveryPromptFeedback[]> {
    if (run.prNumber === undefined) return [];
    try {
      const login = await this.deps.github.getAuthenticatedUser();
      return await this.deps.github.listPullRequestFeedback(
        run.owner,
        run.repo,
        run.prNumber,
        run.issueNumber,
        [login],
      );
    } catch {
      return [];
    }
  }

  private assertConfigReady(): void {
    const errors = validateGlobalConfig(this.deps.config);
    if (errors.length > 0) throw new Error(`Invalid conductor config:\n${errors.join("\n")}`);
  }
}

export function isEligibleForAutomatedDispatch(
  workItem: WorkItem,
  dispatchLabel: string,
  authenticatedLogin: string,
): boolean {
  return workItem.labels.includes(dispatchLabel) && workItem.assignees.includes(authenticatedLogin);
}

function selectLaunchFlags(
  workflow: WorkflowFile,
  config: ResolvedRepositoryConfig,
  workItem: WorkItem,
  plan: WorktreePlan,
  runId: string,
): string[] {
  const context = buildExpressionContext({
    config,
    workflow,
    workItem,
    plan,
    runId,
    attempt: 1,
  });
  for (const rule of workflow.frontmatter.launchRules ?? []) {
    if (evaluateCondition(rule.if, context)) return rule.flags;
  }
  return [];
}

function runToPlan(run: RunRecord): WorktreePlan {
  return {
    owner: run.owner,
    repo: run.repo,
    issueNumber: run.issueNumber,
    slug: slugify(run.issueTitle),
    branch: run.branch,
    baseRef: run.baseRef,
    worktreePath: run.worktreePath,
  };
}

function runToWorkItem(run: RunRecord): WorkItem {
  return {
    projectItemId: run.projectItemId,
    ...(run.projectId === undefined ? {} : { projectId: run.projectId }),
    owner: run.owner,
    repo: run.repo,
    issueNumber: run.issueNumber,
    issueUrl: run.issueUrl,
    title: run.issueTitle,
    body: "",
    labels: [],
    assignees: [],
    projectFields: {},
  };
}

function sameRepository(
  workItem: Pick<WorkItem, "owner" | "repo">,
  config: Pick<ResolvedRepositoryConfig, "owner" | "repo">,
): boolean {
  return (
    workItem.owner.toLowerCase() === config.owner.toLowerCase() &&
    workItem.repo.toLowerCase() === config.repo.toLowerCase()
  );
}

function formatPullRequestFeedback(feedback: { kind: string; body: string; url?: string }): string {
  return [
    `GitHub PR feedback (${feedback.kind}) needs follow-up.`,
    feedback.url === undefined ? undefined : `URL: ${feedback.url}`,
    "",
    feedback.body,
    "",
    "Address this on same branch and PR. Push fixes and summarize verification.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
