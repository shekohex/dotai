import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitNotifyPublish } from "../notify/index.js";
import { NOTIFY_DEFAULT_TOPIC } from "../notify/settings.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { registerGoalCommand } from "./commands.js";
import {
  completionBudgetReport,
  formatDuration,
  formatFooterStatus,
  formatInteger,
} from "./format.js";
import { budgetLimitPrompt, continuationGoalIdFromPrompt, continuationPrompt } from "./prompts.js";
import {
  applyUsage,
  clearEntry,
  goalWithLiveUsage,
  reconstructGoal,
  setEntry,
  updateGoalStatus,
} from "./state.js";
import { registerGoalTools } from "./tools.js";
import {
  GOAL_EXTENSION_ENTRY_TYPE,
  GOAL_STATUS_KEY,
  type GoalEntrySource,
  type GoalResult,
  type ThreadGoal,
} from "./types.js";

interface GoalAccountingState {
  activeGoalId: string | null;
  lastAccountedAt: number | null;
  budgetWarningSentFor: string | null;
}

interface GoalStatusContext {
  ui: Pick<ExtensionContext["ui"], "setStatus">;
}

interface AssistantUsage {
  input: number;
  output: number;
}

interface QueuedGoalMessageDetails {
  kind?:
    | "continuation"
    | "command_start"
    | "command_resume"
    | "budget_limit"
    | "stale_continuation";
  goalId?: string;
  currentGoalId?: string | null;
  currentStatus?: ThreadGoal["status"] | null;
}

interface GoalCustomMessageLike {
  role: "custom";
  customType: string;
  details?: unknown;
  content: unknown;
  display?: boolean;
}

const QueuedGoalMessageDetailsSchema = Type.Object(
  {
    kind: Type.Optional(
      Type.Union([
        Type.Literal("continuation"),
        Type.Literal("command_start"),
        Type.Literal("command_resume"),
        Type.Literal("budget_limit"),
        Type.Literal("stale_continuation"),
      ]),
    ),
    goalId: Type.Optional(Type.String()),
    currentGoalId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    currentStatus: Type.Optional(
      Type.Union([
        Type.Literal("active"),
        Type.Literal("paused"),
        Type.Literal("budgetLimited"),
        Type.Literal("complete"),
        Type.Null(),
      ]),
    ),
  },
  { additionalProperties: false },
);

const GOAL_STATUS_REFRESH_INTERVAL_MS = 1_000;
const CONTINUATION_CONTEXT_USAGE_PERCENT_LIMIT = 95;

function usageChannelTokens(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

function assistantTurnTokens(message: { role: string; usage?: AssistantUsage }): number {
  if (message.role !== "assistant" || !message.usage) {
    return 0;
  }

  return usageChannelTokens(message.usage.input) + usageChannelTokens(message.usage.output);
}

function isAbortedAssistantMessage(message: { role: string; stopReason?: string }): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}

function isToolUseAssistantMessage(message: { role: string; stopReason?: string }): boolean {
  return message.role === "assistant" && message.stopReason === "toolUse";
}

function isQueuedGoalWorkKind(kind: QueuedGoalMessageDetails["kind"]): boolean {
  return kind === "continuation" || kind === "command_start" || kind === "command_resume";
}

function parseQueuedGoalMessageDetails(
  details: GoalCustomMessageLike["details"],
): QueuedGoalMessageDetails | null {
  if (!Value.Check(QueuedGoalMessageDetailsSchema, details)) {
    return null;
  }

  return Value.Parse(QueuedGoalMessageDetailsSchema, details);
}

function staleGoalContinuationMessage(
  queuedGoalId: string,
  currentGoal: ThreadGoal | null,
): string {
  const currentState = currentGoal
    ? `Current goal id: ${currentGoal.goalId}; current status: ${currentGoal.status}.`
    : "There is no current goal.";
  return [
    "Queued hidden goal continuation is stale because referenced goal is no longer active.",
    `Queued goal id: ${queuedGoalId}.`,
    currentState,
    "Do not perform task work. Do not call tools. Reply briefly that queued goal continuation is no longer active.",
  ].join("\n");
}

function isSessionMessageEntryLike(
  value: unknown,
): value is { type: "message"; message: { role: string; content?: unknown } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "message" &&
    "message" in value &&
    typeof value.message === "object" &&
    value.message !== null &&
    "role" in value.message &&
    typeof value.message.role === "string"
  );
}

function isTextContentLike(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

function lastAssistantMessageText(ctx: ExtensionContext): string | null {
  const branch = ctx.sessionManager.getBranch() as Array<unknown>;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!isSessionMessageEntryLike(entry)) {
      continue;
    }
    if (entry.message.role !== "assistant") {
      continue;
    }
    const content = entry.message.content;
    if (typeof content === "string" && content.length > 0) {
      return content;
    }
    if (Array.isArray(content)) {
      const text = content
        .filter((item) => isTextContentLike(item))
        .map((item) => item.text.trim())
        .filter((item) => item.length > 0)
        .join("\n")
        .trim();
      if (text.length > 0) {
        return text;
      }
    }
  }
  return null;
}

function goalCompletionNotificationMessage(goal: ThreadGoal, ctx: ExtensionContext): string {
  const parts = [lastAssistantMessageText(ctx) ?? "Goal complete"];
  const budgetReport = completionBudgetReport(goal);
  if (budgetReport !== null) {
    parts.push(budgetReport);
  }
  return parts.join("\n\n");
}

function goalUnmetNotificationMessage(goal: ThreadGoal, ctx: ExtensionContext): string {
  const parts = [lastAssistantMessageText(ctx) ?? "Goal budget exhausted"];
  const usageParts: string[] = [];
  if (goal.usage.activeSeconds > 0) {
    usageParts.push(`time used: ${formatDuration(goal.usage.activeSeconds)}.`);
  }
  if (goal.tokenBudget !== null) {
    usageParts.push(
      `tokens used: ${formatInteger(goal.usage.tokensUsed)} of ${formatInteger(goal.tokenBudget)}.`,
    );
  } else if (goal.usage.tokensUsed > 0) {
    usageParts.push(`tokens used: ${formatInteger(goal.usage.tokensUsed)}.`);
  }
  if (usageParts.length > 0) {
    parts.push(`Goal unmet. ${usageParts.join(" ")}`);
  }
  return parts.join("\n\n");
}

function queuedGoalWorkMessageId(message: GoalCustomMessageLike): string | null {
  if (message.customType !== GOAL_EXTENSION_ENTRY_TYPE) {
    return null;
  }

  const details = parseQueuedGoalMessageDetails(message.details);
  const { kind, goalId } = details ?? {};
  if (isQueuedGoalWorkKind(kind) && goalId !== undefined) {
    return goalId;
  }

  if (typeof message.content !== "string") {
    return null;
  }

  return continuationGoalIdFromPrompt(message.content);
}

const CONTINUATION_RETRY_MS = 50;

class GoalRuntime {
  private goal: ThreadGoal | null = null;
  private isCompacting = false;
  private continuationQueuedFor: string | null = null;
  private continuationScheduledFor: string | null = null;
  private continuationTimer: ReturnType<typeof setTimeout> | null = null;
  private statusContext: GoalStatusContext | null = null;
  private statusRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly accounting: GoalAccountingState = {
    activeGoalId: null,
    lastAccountedAt: null,
    budgetWarningSentFor: null,
  };

  constructor(private readonly pi: ExtensionAPI) {}

  register(): void {
    registerGoalTools(this.pi, {
      getGoal: () => this.goalForDisplay(),
      setGoal: (nextGoal, source, ctx) => {
        this.persistGoal(nextGoal, source);
        this.refreshUi(ctx);
      },
      completeGoal: (source, ctx) => this.completeGoal(source, ctx),
    });

    registerGoalCommand(this.pi, {
      getGoal: () => this.goalForDisplay(),
      setGoal: (nextGoal, source, ctx) => {
        this.persistGoal(nextGoal, source);
        if (source === "command" && nextGoal.status === "active") {
          this.continuationQueuedFor = nextGoal.goalId;
        }
        this.refreshUi(ctx);
      },
      clearGoal: (source, ctx) => {
        this.persistClear(source);
        this.refreshUi(ctx);
      },
    });

    this.registerEventHandlers();
  }

  private goalForDisplay(): ThreadGoal | null {
    return goalWithLiveUsage(
      this.goal,
      this.accounting.activeGoalId,
      this.accounting.lastAccountedAt,
    );
  }

  private stopStatusRefresh(): void {
    if (this.statusRefreshTimer !== null) {
      clearInterval(this.statusRefreshTimer);
      this.statusRefreshTimer = null;
    }
  }

  private clearContinuationTimer(): void {
    if (this.continuationTimer !== null) {
      clearTimeout(this.continuationTimer);
      this.continuationTimer = null;
    }
    this.continuationScheduledFor = null;
  }

  private clearContinuationState(): void {
    this.clearContinuationTimer();
    this.continuationQueuedFor = null;
  }

  private clearActiveAccounting(): void {
    this.accounting.activeGoalId = null;
    this.accounting.lastAccountedAt = null;
  }

  private clearStoppedRuntimeState(): void {
    this.clearContinuationState();
    this.clearActiveAccounting();
  }

  private syncStatusRefresh(): void {
    if (
      this.goal?.status === "active" &&
      this.statusContext !== null &&
      this.statusRefreshTimer === null
    ) {
      this.statusRefreshTimer = setInterval(() => {
        if (this.statusContext === null || this.goal?.status !== "active") {
          this.stopStatusRefresh();
          return;
        }

        this.statusContext.ui.setStatus(GOAL_STATUS_KEY, formatFooterStatus(this.goalForDisplay()));
      }, GOAL_STATUS_REFRESH_INTERVAL_MS);
      this.statusRefreshTimer.unref?.();
      return;
    }

    if (this.goal?.status !== "active") {
      this.stopStatusRefresh();
    }
  }

  private refreshUi(ctx: GoalStatusContext): void {
    this.statusContext = ctx;
    ctx.ui.setStatus(GOAL_STATUS_KEY, formatFooterStatus(this.goalForDisplay()));
    this.syncStatusRefresh();
  }

  private persistGoal(nextGoal: ThreadGoal, source: GoalEntrySource): void {
    const previousGoalId = this.goal?.goalId ?? null;
    this.goal = nextGoal;
    if (previousGoalId !== nextGoal.goalId) {
      this.accounting.budgetWarningSentFor = null;
      this.clearStoppedRuntimeState();
    }

    if (nextGoal.status === "paused" || nextGoal.status === "complete") {
      this.clearStoppedRuntimeState();
    } else if (nextGoal.status === "budgetLimited") {
      this.clearContinuationState();
    }

    if (nextGoal.status !== "budgetLimited") {
      this.accounting.budgetWarningSentFor = null;
    }

    this.pi.appendEntry(GOAL_EXTENSION_ENTRY_TYPE, setEntry(nextGoal, source));
  }

  private persistClear(source: GoalEntrySource): void {
    const clearedGoalId = this.goal?.goalId ?? null;
    this.goal = null;
    this.clearStoppedRuntimeState();
    this.stopStatusRefresh();
    this.pi.appendEntry(GOAL_EXTENSION_ENTRY_TYPE, clearEntry(clearedGoalId, source));
  }

  private pauseForAbort(ctx: ExtensionContext): void {
    if (this.goal === null || this.goal.status !== "active") {
      return;
    }

    const result = updateGoalStatus(this.goal, "paused");
    if (!result.ok || result.goal === null) {
      return;
    }

    this.clearStoppedRuntimeState();
    this.persistGoal(result.goal, "runtime");
    this.refreshUi(ctx);
  }

  private resumePausedGoal(ctx: ExtensionContext): void {
    if (this.goal === null || this.goal.status !== "paused") {
      return;
    }

    const result = updateGoalStatus(this.goal, "active");
    if (!result.ok || result.goal === null) {
      return;
    }

    this.clearContinuationState();
    this.persistGoal(result.goal, "runtime");
    this.refreshUi(ctx);
  }

  private reloadFromSession(ctx: ExtensionContext): void {
    this.goal = reconstructGoal(ctx.sessionManager.getBranch()).goal;
    this.clearContinuationState();
    if (this.goal?.status !== "active") {
      this.clearActiveAccounting();
    }
    this.refreshUi(ctx);
  }

  private beginAccounting(): void {
    if (this.goal === null || this.goal.status !== "active") {
      this.accounting.activeGoalId = null;
      this.accounting.lastAccountedAt = null;
      return;
    }

    this.accounting.activeGoalId = this.goal.goalId;
    this.accounting.lastAccountedAt = Date.now();
  }

  private accountProgress(
    ctx: ExtensionContext,
    allowBudgetSteering: boolean,
    completedTurnTokens = 0,
    accountBudgetLimited = false,
  ): void {
    const canAccount =
      this.goal?.status === "active" ||
      (accountBudgetLimited && this.goal?.status === "budgetLimited");
    if (this.goal === null || this.accounting.activeGoalId !== this.goal.goalId || !canAccount) {
      this.beginAccounting();
      return;
    }

    const now = Date.now();
    const elapsed =
      this.accounting.lastAccountedAt === null
        ? 0
        : Math.floor((now - this.accounting.lastAccountedAt) / 1000);
    this.accounting.lastAccountedAt = now;

    const result = applyUsage(this.goal, completedTurnTokens, elapsed, {
      expectedGoalId: this.accounting.activeGoalId,
      accountBudgetLimited,
    });
    if (!result.changed || result.goal === null) {
      return;
    }

    this.persistGoal(result.goal, "runtime");
    this.refreshUi(ctx);

    if (
      allowBudgetSteering &&
      result.crossedBudget &&
      this.accounting.budgetWarningSentFor !== result.goal.goalId
    ) {
      this.accounting.budgetWarningSentFor = result.goal.goalId;
      emitNotifyPublish(this.pi, {
        topic: NOTIFY_DEFAULT_TOPIC,
        title: "Goal unmet",
        message: goalUnmetNotificationMessage(result.goal, ctx),
        tags: ["goal", "unmet", "budget"],
        meta: {
          sourceExtension: "goal",
          eventName: "goal:budget_exhausted",
          correlationId: result.goal.goalId,
        },
      });
      this.pi.sendMessage(
        {
          customType: GOAL_EXTENSION_ENTRY_TYPE,
          content: budgetLimitPrompt(result.goal),
          display: false,
          details: { kind: "budget_limit", goalId: result.goal.goalId },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }

  private completeGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult {
    this.accountProgress(ctx, false, 0, true);
    const result = updateGoalStatus(this.goal, "complete");
    if (!result.ok || result.goal === null) {
      return result;
    }

    this.persistGoal(result.goal, source);
    emitNotifyPublish(this.pi, {
      topic: NOTIFY_DEFAULT_TOPIC,
      title: "Goal complete",
      message: goalCompletionNotificationMessage(result.goal, ctx),
      tags: ["goal", "complete"],
      meta: {
        sourceExtension: "goal",
        eventName: "goal:complete",
        correlationId: result.goal.goalId,
      },
    });
    this.refreshUi(ctx);
    return result;
  }

  private sendContinuation(goal: ThreadGoal): void {
    this.continuationQueuedFor = goal.goalId;
    this.pi.sendMessage(
      {
        customType: GOAL_EXTENSION_ENTRY_TYPE,
        content: continuationPrompt(goal),
        display: false,
        details: { kind: "continuation", goalId: goal.goalId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  private maybeContinue(ctx: ExtensionContext): void {
    if (
      this.goal === null ||
      this.goal.status !== "active" ||
      this.continuationQueuedFor === this.goal.goalId
    ) {
      return;
    }

    if (this.isCompacting || this.isContextNearLimit(ctx)) {
      return;
    }

    const goalId = this.goal.goalId;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      if (this.continuationScheduledFor === goalId) {
        return;
      }

      this.continuationScheduledFor = goalId;
      this.continuationTimer = setTimeout(() => {
        this.continuationTimer = null;
        this.continuationScheduledFor = null;
        this.maybeContinue(ctx);
      }, CONTINUATION_RETRY_MS);
      this.continuationTimer.unref?.();
      return;
    }

    this.clearContinuationTimer();
    if (this.goal === null || this.goal.status !== "active" || this.goal.goalId !== goalId) {
      return;
    }

    this.sendContinuation(this.goal);
  }

  private isContextNearLimit(ctx: ExtensionContext): boolean {
    const usage = ctx.getContextUsage();
    const percent = usage?.percent;
    if (percent === null || percent === undefined || !Number.isFinite(percent)) {
      return false;
    }

    return percent >= CONTINUATION_CONTEXT_USAGE_PERCENT_LIMIT;
  }

  private async handleSessionStart(
    event: { reason: string },
    ctx: ExtensionContext,
  ): Promise<void> {
    this.reloadFromSession(ctx);
    this.beginAccounting();
    if (event.reason === "resume" && this.goal?.status === "paused" && ctx.hasUI) {
      const shouldResume = await ctx.ui.confirm(
        "Resume paused goal?",
        `Goal: ${this.goal.objective}`,
      );
      if (shouldResume) {
        this.resumePausedGoal(ctx);
        this.beginAccounting();
      }
    }
    this.maybeContinue(ctx);
  }

  private handleSessionTree(_event: object, ctx: ExtensionContext): void {
    this.reloadFromSession(ctx);
    this.beginAccounting();
    this.maybeContinue(ctx);
  }

  private handleBeforeAgentStart(
    event: { prompt: string; systemPrompt: string },
    ctx: ExtensionContext,
  ): { systemPrompt: string } | undefined {
    const continuationGoalId = continuationGoalIdFromPrompt(event.prompt);
    if (continuationGoalId === null) {
      this.clearContinuationState();
      return undefined;
    }

    this.continuationQueuedFor = null;
    this.clearContinuationTimer();
    const isCurrentGoal =
      this.goal !== null &&
      this.goal.goalId === continuationGoalId &&
      this.goal.status === "active";
    if (isCurrentGoal) {
      return undefined;
    }

    ctx.abort();
    this.refreshUi(ctx);
    return {
      systemPrompt: [
        event.systemPrompt,
        "",
        staleGoalContinuationMessage(continuationGoalId, this.goal),
      ].join("\n"),
    };
  }

  private handleTurnStart(_event: object, ctx: ExtensionContext): void {
    this.clearContinuationState();
    this.beginAccounting();
    this.refreshUi(ctx);
  }

  private handleToolExecutionEnd(_event: object, ctx: ExtensionContext): void {
    this.accountProgress(ctx, true, 0, true);
  }

  private handleTurnEnd(
    event: { message: { role: string; usage?: AssistantUsage; stopReason?: string } },
    ctx: ExtensionContext,
  ): void {
    const completedTurnTokens = assistantTurnTokens(event.message);
    this.accountProgress(ctx, true, completedTurnTokens);
    if (isAbortedAssistantMessage(event.message)) {
      this.pauseForAbort(ctx);
      return;
    }

    if (!isToolUseAssistantMessage(event.message)) {
      this.maybeContinue(ctx);
    }
  }

  private handleAgentEnd(
    event: { messages: Array<{ role: string; usage?: AssistantUsage; stopReason?: string }> },
    ctx: ExtensionContext,
  ): void {
    const abortedMessages = event.messages.filter(isAbortedAssistantMessage);
    const abortedTurnTokens = abortedMessages.reduce(
      (sum, message) => sum + assistantTurnTokens(message),
      0,
    );
    this.accountProgress(ctx, false, abortedTurnTokens, true);
    if (abortedMessages.length > 0) {
      this.pauseForAbort(ctx);
      return;
    }

    this.maybeContinue(ctx);
  }

  private handleSessionBeforeCompact(_event: object, ctx: ExtensionContext): void {
    this.isCompacting = true;
    this.accountProgress(ctx, false, 0, true);
  }

  private handleSessionCompact(_event: object, ctx: ExtensionContext): void {
    this.isCompacting = false;
    if (this.goal !== null) {
      this.persistGoal(this.goal, "runtime");
    }
    this.refreshUi(ctx);
    this.maybeContinue(ctx);
  }

  private handleSessionShutdown(_event: object, ctx: ExtensionContext): void {
    this.isCompacting = false;
    this.accountProgress(ctx, false, 0, true);
    this.clearContinuationTimer();
    this.stopStatusRefresh();
  }

  private registerEventHandlers(): void {
    this.pi.on("context", (event) => {
      let changed = false;
      const messages = event.messages.map((message) => {
        if (message.role !== "custom") {
          return message;
        }

        const queuedGoalId = queuedGoalWorkMessageId(message);
        const isCurrentActiveGoal =
          queuedGoalId !== null &&
          this.goal?.goalId === queuedGoalId &&
          this.goal.status === "active";
        if (queuedGoalId === null || isCurrentActiveGoal) {
          return message;
        }

        changed = true;
        return {
          ...message,
          content: staleGoalContinuationMessage(queuedGoalId, this.goal),
          display: false,
          details: {
            kind: "stale_continuation",
            goalId: queuedGoalId,
            currentGoalId: this.goal?.goalId ?? null,
            currentStatus: this.goal?.status ?? null,
          },
        };
      });

      return changed ? { messages } : undefined;
    });
    this.pi.on("session_start", (event, ctx) => {
      return this.handleSessionStart(event, ctx);
    });
    this.pi.on("session_tree", (event, ctx) => {
      this.handleSessionTree(event, ctx);
    });
    this.pi.on("before_agent_start", (event, ctx) => {
      return this.handleBeforeAgentStart(event, ctx);
    });
    this.pi.on("turn_start", (event, ctx) => {
      this.handleTurnStart(event, ctx);
    });
    this.pi.on("tool_execution_end", (event, ctx) => {
      this.handleToolExecutionEnd(event, ctx);
    });
    this.pi.on("turn_end", (event, ctx) => {
      this.handleTurnEnd(event, ctx);
    });
    this.pi.on("agent_end", (event, ctx) => {
      this.handleAgentEnd(event, ctx);
    });
    this.pi.on("session_before_compact", (event, ctx) => {
      this.handleSessionBeforeCompact(event, ctx);
    });
    this.pi.on("session_compact", (event, ctx) => {
      this.handleSessionCompact(event, ctx);
    });
    this.pi.on("compaction_start", () => {
      this.isCompacting = true;
    });
    this.pi.on("compaction_end", () => {
      this.isCompacting = false;
    });
    this.pi.on("session_shutdown", (event, ctx) => {
      this.handleSessionShutdown(event, ctx);
    });
  }
}

export default function goalExtension(pi: ExtensionAPI): void {
  new GoalRuntime(pi).register();
}
