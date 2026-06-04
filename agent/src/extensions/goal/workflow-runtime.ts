import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  generateGoalWorkflow,
  generateRunId,
  WorkflowManager,
  type WorkflowRunResult,
} from "../dynamic-workflows/index.js";
import { errorMessage } from "../../utils/error-message.js";
import {
  addGoalWorkflowUsage,
  blockGoal,
  replaceWorkflowGoal,
  sendVisibleGoalMessage,
  unblockGoal,
  updateGoalWorkflowCounters,
  updateGoalStatus,
} from "./state.js";
import {
  GoalWorkflowCountersSchema,
  type GoalEntrySource,
  type GoalWorkflowCounters,
  type ThreadGoal,
} from "./types.js";
import { parseGoalWorkflowObjective } from "./workflow.js";

export interface GoalWorkflowObjectiveInput {
  objective: string;
  label: string;
  source: "inline" | "file";
  objectiveFile?: string;
}

export interface GoalWorkflowRuntimeOptions {
  pi: ExtensionAPI;
  getGoal: () => ThreadGoal | null;
  persistGoal: (goal: ThreadGoal, source: GoalEntrySource) => void;
  refreshUi: (ctx: ExtensionContext) => void;
  createManager?: (ctx: ExtensionContext) => GoalWorkflowManager;
}

interface GoalWorkflowManager {
  startInBackground(
    script: string,
    args?: unknown,
    exec?: { subagentBackend?: "process"; runId?: string; displayName?: string },
  ): { runId: string; promise: Promise<WorkflowRunResult> };
  resumeInBackground(
    runId: string,
    resumeArgs?: unknown,
  ): { runId: string; promise: Promise<WorkflowRunResult> } | false;
}

const GoalWorkflowCompleteResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    status: Type.Literal("complete"),
  },
  { additionalProperties: true },
);

type GoalWorkflowCompleteResult = Static<typeof GoalWorkflowCompleteResultSchema>;

export class GoalWorkflowRuntime {
  constructor(private readonly options: GoalWorkflowRuntimeOptions) {}

  async start(objective: GoalWorkflowObjectiveInput, ctx: ExtensionContext): Promise<void> {
    const current = this.options.getGoal();
    if (current && current.status !== "complete") {
      if (!ctx.hasUI) {
        ctx.ui.notify("Clear existing goal before replacing it.", "error");
        return;
      }
      const shouldReplace = await ctx.ui.confirm(
        "Replace goal?",
        `Current goal:\n${current.objective}\n\nNew workflow goal:\n${objective.label}`,
      );
      if (!shouldReplace) {
        ctx.ui.notify("Goal unchanged.");
        return;
      }
    }

    const parsedObjective = this.parseObjective(objective.objective, ctx);
    if (parsedObjective === null) return;

    const runId = generateRunId();
    const startedAt = new Date().toISOString();
    const startCommit = await this.currentGitCommit(ctx);
    const result = replaceWorkflowGoal(parsedObjective.objective, {
      runId,
      workflowName: "goal",
      objectiveSource: objective.source,
      objectiveFile: objective.objectiveFile,
      startCommit,
      startedAt,
    });
    if (!result.ok || result.goal === null) {
      ctx.ui.notify(result.message, "error");
      return;
    }

    this.options.persistGoal(result.goal, "command");
    this.options.refreshUi(ctx);
    const workflow = this.createManager(ctx).startInBackground(
      generateGoalWorkflow(),
      { ...parsedObjective, startCommit, startedAt, runId },
      { runId, subagentBackend: "process", displayName: goalWorkflowDisplayName(objective, ctx) },
    );
    ctx.ui.notify(`Goal workflow started. Run ID: ${workflow.runId}`);
    this.watch(workflow.runId, workflow.promise, ctx);
  }

  resume(ctx: ExtensionContext, reason?: string): void {
    const current = this.options.getGoal();
    const runId = current?.workflow?.runId;
    if (current === null || runId === undefined) {
      ctx.ui.notify("No workflow goal is available to resume.", "warning");
      return;
    }
    if (current.status === "blocked" && reason === undefined) {
      ctx.ui.notify(
        "Use /goal workflow unblock <reason> to resume blocked workflow goals.",
        "warning",
      );
      return;
    }
    const resumed = this.createManager(ctx).resumeInBackground(
      runId,
      reason === undefined
        ? workflowResumeArgs(current)
        : {
            ...workflowResumeArgs(current),
            unblockReason: reason,
            unblockedAt: new Date().toISOString(),
          },
    );
    if (resumed === false) {
      ctx.ui.notify(`Goal workflow ${runId} is not resumable.`, "warning");
      return;
    }
    this.activateForResume(current, runId, reason, ctx);
    this.sendResumeMessage(runId, reason);
    ctx.ui.notify(`Goal workflow resumed. Run ID: ${runId}`);
    this.watch(runId, resumed.promise, ctx);
  }

  private watch(runId: string, promise: Promise<WorkflowRunResult>, ctx: ExtensionContext): void {
    promise
      .then((workflowResult) => {
        this.complete(runId, workflowResult, ctx);
      })
      .catch((error: unknown) => {
        this.block(runId, error, ctx);
      });
  }

  private parseObjective(objective: string, ctx: ExtensionContext) {
    try {
      return parseGoalWorkflowObjective(objective);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
      return null;
    }
  }

  private createManager(ctx: ExtensionContext): GoalWorkflowManager {
    if (this.options.createManager !== undefined) return this.options.createManager(ctx);
    return new WorkflowManager({
      cwd: ctx.cwd,
      pi: this.options.pi,
      ctx,
      subagentBackend: "process",
    });
  }

  private async currentGitCommit(ctx: ExtensionContext): Promise<string> {
    const result = await this.options.pi.exec("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: ctx.cwd,
    });
    return result.code === 0 ? result.stdout.trim() : "";
  }

  private complete(runId: string, workflowResult: WorkflowRunResult, ctx: ExtensionContext): void {
    const current = this.options.getGoal();
    if (current?.workflow?.runId !== runId) return;
    const goalWithUsage = updateGoalWorkflowCounters(
      addGoalWorkflowUsage(current, {
        tokens: workflowResult.tokenUsage?.total,
        activeSeconds: Math.ceil((workflowResult.durationMs ?? 0) / 1000),
      }),
      workflowCounters(workflowResult.result),
    );
    if (!workflowResultComplete(workflowResult.result)) {
      const reason = workflowBlockReason(runId, workflowResult.result);
      const blocked = blockGoal(goalWithUsage, reason);
      if (blocked.ok && blocked.goal !== null) {
        this.persist(blocked.goal, ctx);
        this.sendBlockedMessage(runId, workflowResult.result);
        ctx.ui.notify(
          `Goal workflow blocked. ${workflowBlockSummary(workflowResult.result)}`,
          "warning",
        );
      }
      return;
    }
    const completed = updateGoalStatus(goalWithUsage, "complete");
    if (completed.ok && completed.goal !== null) {
      this.persist(completed.goal, ctx);
      this.sendCompletionMessage(runId, workflowResult.result);
      ctx.ui.notify("Goal workflow complete.");
    }
  }

  private sendCompletionMessage(runId: string, result: unknown): void {
    sendVisibleGoalMessage(this.options.pi, workflowCompletionMessage(runId, result), {
      kind: "workflow-complete",
      runId,
      result,
    });
  }

  private sendBlockedMessage(runId: string, result: unknown): void {
    sendVisibleGoalMessage(this.options.pi, workflowBlockedMessage(runId, result), {
      kind: "workflow-blocked",
      runId,
      result,
    });
  }

  private sendFailedMessage(runId: string, error: unknown): void {
    sendVisibleGoalMessage(this.options.pi, workflowFailedMessage(runId, error), {
      kind: "workflow-failed-blocked",
      runId,
      error: errorMessage(error),
    });
  }

  private sendResumeMessage(runId: string, reason: string | undefined): void {
    sendVisibleGoalMessage(this.options.pi, workflowResumeMessage(runId, reason), {
      kind: reason === undefined ? "workflow-resumed" : "workflow-unblocked",
      runId,
      reason,
    });
  }

  private block(runId: string, error: unknown, ctx: ExtensionContext): void {
    const current = this.options.getGoal();
    if (current?.workflow?.runId !== runId) return;
    const reason = workflowErrorReason(runId, error);
    const blocked = blockGoal(current, reason);
    if (blocked.ok && blocked.goal !== null) {
      this.persist(blocked.goal, ctx);
      this.sendFailedMessage(runId, error);
      ctx.ui.notify(`Goal workflow failed. ${errorMessage(error)}`, "error");
    }
  }

  private activateForResume(
    current: ThreadGoal,
    runId: string,
    reason: string | undefined,
    ctx: ExtensionContext,
  ): void {
    if (current.status === "blocked") {
      const unblocked = unblockGoal(
        current,
        reason ?? `Resuming workflow run ${runId} after user requested /goal workflow resume.`,
      );
      if (unblocked.ok && unblocked.goal !== null) this.persist(unblocked.goal, ctx);
      return;
    }

    if (current.status === "paused") {
      const resumed = updateGoalStatus(current, "active");
      if (resumed.ok && resumed.goal !== null) this.persist(resumed.goal, ctx);
    }
  }

  private persist(goal: ThreadGoal, ctx: ExtensionContext): void {
    this.options.persistGoal(goal, "runtime");
    this.options.refreshUi(ctx);
  }
}

function workflowResumeArgs(
  goal: ThreadGoal,
): { workflowCounters: GoalWorkflowCounters } | undefined {
  const counters = goal.workflow?.counters;
  return counters === undefined ? undefined : { workflowCounters: counters };
}

function workflowResultComplete(result: unknown): result is GoalWorkflowCompleteResult {
  return Value.Check(GoalWorkflowCompleteResultSchema, result);
}

function workflowBlockReason(runId: string, result: unknown): string {
  return [
    `Goal workflow ${runId} finished without satisfying the goal.`,
    "Review the workflow result and resume or restart the workflow after addressing blockers.",
    JSON.stringify(result, null, 2),
  ].join("\n\n");
}

function workflowErrorReason(runId: string, error: unknown): string {
  return [
    `Goal workflow ${runId} failed before completion.`,
    "Inspect the workflow run, fix the cause, then resume the workflow when ready.",
    errorMessage(error),
  ].join("\n\n");
}

function workflowBlockSummary(result: unknown): string {
  if (result !== null && typeof result === "object" && "status" in result) {
    const status = result.status;
    if (typeof status === "string" && status.length > 0) return `Status: ${status}.`;
  }
  return "Inspect blocked reason for details.";
}

function workflowBlockedMessage(runId: string, result: unknown): string {
  const parts = [`Goal workflow blocked. Run ID: ${runId}`];
  const status = workflowStringField(result, "status");
  const summary = workflowSummaryText(result);
  const blockers = workflowArrayField(result, "blockers");
  const nextAction =
    workflowStringField(result, "nextAction") ??
    workflowStringField(workflowObjectField(result, "summary"), "nextAction");
  if (status !== undefined) parts.push(`Status: ${status}`);
  if (summary.length > 0) parts.push(summary);
  if (blockers.length > 0)
    parts.push(["Blockers:", ...blockers.map((blocker) => `- ${blocker}`)].join("\n"));
  if (nextAction !== undefined) parts.push(`Next action: ${nextAction}`);
  return parts.join("\n\n");
}

function workflowFailedMessage(runId: string, error: unknown): string {
  return [
    `Goal workflow failed and is blocked. Run ID: ${runId}`,
    `Error: ${errorMessage(error)}`,
    "Fix the workflow failure, then resume with /goal workflow resume or unblock with /goal workflow unblock <reason>.",
  ].join("\n\n");
}

function workflowResumeMessage(runId: string, reason: string | undefined): string {
  return [
    reason === undefined
      ? `Goal workflow resumed. Run ID: ${runId}`
      : `Goal workflow unblocked and resumed. Run ID: ${runId}`,
    reason === undefined ? "Reason: user requested workflow resume." : `Reason: ${reason}`,
  ].join("\n\n");
}

function workflowCompletionMessage(runId: string, result: unknown): string {
  const summary = workflowSummaryText(result);
  return [`Goal workflow complete. Run ID: ${runId}`, summary]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function workflowSummaryText(result: unknown): string {
  if (result !== null && typeof result === "object" && "summary" in result) {
    const summary = result.summary;
    if (typeof summary === "string") return summary;
    if (summary !== null && typeof summary === "object" && "summary" in summary) {
      const text = summary.summary;
      if (typeof text === "string") return text;
    }
  }
  return JSON.stringify(result, null, 2);
}

function workflowObjectField(result: unknown, key: string): unknown {
  if (isWorkflowRecord(result)) return result[key];
  return undefined;
}

function isWorkflowRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function workflowStringField(result: unknown, key: string): string | undefined {
  const value = workflowObjectField(result, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function workflowArrayField(result: unknown, key: string): string[] {
  const value = workflowObjectField(result, key);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function workflowCounters(result: unknown): GoalWorkflowCounters | undefined {
  const metrics = workflowObjectField(result, "metrics");
  if (!isWorkflowRecord(metrics)) return undefined;
  const counters = {
    iterations: metrics.iterations,
    reviewCount: metrics.reviewCount,
    judgeCount: metrics.judgeCount,
    reviewDraftCount: metrics.reviewDraftCount,
    judgeDraftCount: metrics.judgeDraftCount,
    commitCount: metrics.commitCount,
  };
  if (Object.values(counters).every((value) => value === undefined)) return undefined;
  if (!Value.Check(GoalWorkflowCountersSchema, counters)) return undefined;
  return Value.Parse(GoalWorkflowCountersSchema, counters);
}

function goalWorkflowDisplayName(
  objective: GoalWorkflowObjectiveInput,
  ctx: ExtensionContext,
): string {
  if (objective.objectiveFile !== undefined) {
    const base = objective.objectiveFile.split(/[\\/]/u).at(-1) ?? "goal";
    const slug = base
      .replace(/\.[^.]+$/u, "")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-|-$/gu, "")
      .slice(0, 48);
    return slug.length > 0 ? `goal-${slug}` : "goal-file";
  }
  return `goal-${ctx.sessionManager.getSessionId().slice(0, 8)}`;
}
