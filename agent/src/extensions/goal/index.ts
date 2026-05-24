import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createToolStateEntry,
  readToolState,
  TOOL_STATE_ENTRY_TYPE,
} from "../../utils/tool-state.js";
import { emitNotifyPublish } from "../notify/index.js";
import { NOTIFY_DEFAULT_TOPIC } from "../notify/settings.js";
import { getContextPruneAPI } from "../context-prune/public-api.js";
import { registerGoalCommand } from "./commands.js";
import { completionUsageReport, formatFooterStatus } from "./format.js";
import {
  assistantTurnTokens,
  isAbortedAssistantMessage,
  isErrorAssistantMessage,
  lastAssistantMessageText,
  type AssistantMessageLike,
} from "./messages.js";
import { continuationGoalIdFromPrompt, continuationPrompt } from "./prompts.js";
import { queuedGoalWorkMessageId, staleGoalContinuationMessage } from "./queued-messages.js";
import {
  branchContainsEntry,
  canResumeFromCompactionAnchor,
  isCurrentSessionPosition,
  sessionPosition,
  type GoalCompactionResumeAnchor,
  type GoalSessionPosition,
  type GoalStatusContext,
  type MaybeContinueOptions,
} from "./session-position.js";
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
  GOAL_BLOCKED_EVENT,
  GOAL_PROGRESS_EVENT,
  GOAL_STATUS_KEY,
  type GoalBlockedEvent,
  type GoalEntrySource,
  type GoalProgressEvent,
  type GoalResult,
  type ThreadGoal,
} from "./types.js";

interface GoalAccountingState {
  activeGoalId: string | null;
  lastAccountedAt: number | null;
}

const GOAL_STATUS_REFRESH_INTERVAL_MS = 1_000;
const CONTINUATION_CONTEXT_USAGE_PERCENT_LIMIT = 95;
const GOAL_TOOL_NAME = "goal";
const COMPACTION_RESUME_DELAY_MS = 150;
const POST_AGENT_SETTLE_DELAY_MS = 150;

function goalCompletionNotificationMessage(goal: ThreadGoal, ctx: ExtensionContext): string {
  const parts = [lastAssistantMessageText(ctx) ?? "Goal complete"];
  const usageReport = completionUsageReport(goal);
  if (usageReport !== null) {
    parts.push(usageReport);
  }
  return parts.join("\n\n");
}

const CONTINUATION_RETRY_MS = 50;

class GoalRuntime {
  private goal: ThreadGoal | null = null;
  private toolRegistered = false;
  private toolEnabled = false;
  private isCompacting = false;
  private continuationBlockedByAssistantError = false;
  private continuationPendingAfterCompaction = false;
  private continuationQueuedFor: string | null = null;
  private continuationScheduledFor: string | null = null;
  private continuationTimer: ReturnType<typeof setTimeout> | null = null;
  private compactionResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private blockedContinuationPosition: GoalSessionPosition | null = null;
  private compactionResumeAnchor: GoalCompactionResumeAnchor | null = null;
  private postAgentSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private postAgentSettlePosition: GoalSessionPosition | null = null;
  private statusContext: GoalStatusContext | null = null;
  private statusRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly accounting: GoalAccountingState = {
    activeGoalId: null,
    lastAccountedAt: null,
  };

  constructor(private readonly pi: ExtensionAPI) {}

  register(): void {
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
      enableTool: () => {
        this.enableTool();
        this.persistToolState();
      },
      disableTool: () => {
        this.disableTool();
        this.persistToolState();
      },
    });

    this.registerEventHandlers();
  }

  private enableTool(): void {
    if (!this.toolRegistered) {
      registerGoalTools(this.pi, {
        getGoal: () => this.goalForDisplay(),
        setGoal: (nextGoal, source, ctx) => {
          this.persistGoal(nextGoal, source);
          this.refreshUi(ctx);
        },
        completeGoal: (source, ctx) => this.completeGoal(source, ctx),
      });
      this.toolRegistered = true;
    }
    this.toolEnabled = true;
    const activeTools = new Set([...this.pi.getActiveTools(), GOAL_TOOL_NAME]);
    this.pi.setActiveTools(
      Array.from(activeTools).toSorted((left, right) => left.localeCompare(right)),
    );
  }

  private disableTool(): void {
    this.toolEnabled = false;
    this.pi.setActiveTools(
      this.pi.getActiveTools().filter((toolName) => toolName !== GOAL_TOOL_NAME),
    );
  }

  private persistToolState(): void {
    this.pi.appendEntry(
      TOOL_STATE_ENTRY_TYPE,
      createToolStateEntry(GOAL_TOOL_NAME, this.toolEnabled),
    );
  }

  private restoreToolState(ctx: ExtensionContext): void {
    const restored = readToolState(ctx.sessionManager.getBranch(), GOAL_TOOL_NAME);
    if (restored === true) {
      this.enableTool();
      return;
    }
    if (restored === false) {
      this.disableTool();
    }
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

  private clearCompactionResumeTimer(): void {
    if (this.compactionResumeTimer !== null) {
      clearTimeout(this.compactionResumeTimer);
      this.compactionResumeTimer = null;
    }
    this.compactionResumeAnchor = null;
  }

  private clearPostAgentSettleTimer(): void {
    if (this.postAgentSettleTimer !== null) {
      clearTimeout(this.postAgentSettleTimer);
      this.postAgentSettleTimer = null;
    }
    this.postAgentSettlePosition = null;
  }

  private clearContinuationState(): void {
    this.clearContinuationTimer();
    this.clearCompactionResumeTimer();
    this.clearPostAgentSettleTimer();
    this.continuationPendingAfterCompaction = false;
    this.blockedContinuationPosition = null;
    this.continuationQueuedFor = null;
  }

  private clearScheduledContinuationAttempts(): void {
    this.clearContinuationTimer();
    this.clearCompactionResumeTimer();
    this.clearPostAgentSettleTimer();
  }

  private suppressCompactionResumeIfPending(): boolean {
    if (!this.continuationPendingAfterCompaction && this.compactionResumeTimer === null) {
      return false;
    }

    this.clearScheduledContinuationAttempts();
    this.continuationPendingAfterCompaction = false;
    this.blockedContinuationPosition = null;
    return true;
  }

  private blockContinuationAfterAssistantError(): void {
    this.clearPostAgentSettleTimer();
    this.continuationBlockedByAssistantError = true;
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
        this.emitGoalProgress(this.statusContext);
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
    this.emitGoalProgress(ctx);
    const goal = this.goalForDisplay();
    if (goal?.status === "blocked") {
      this.emitGoalBlocked(goal, ctx);
    }
    this.syncStatusRefresh();
  }

  private emitGoalProgress(ctx: GoalStatusContext): void {
    const goal = this.goalForDisplay();
    const event: GoalProgressEvent =
      goal?.status === "active"
        ? {
            status: "active",
            sessionId: ctx.sessionManager.getSessionId(),
            cwd: ctx.cwd,
            timeUsedSeconds: goal.usage.activeSeconds,
          }
        : {
            status: "clear",
            sessionId: ctx.sessionManager.getSessionId(),
            cwd: ctx.cwd,
          };
    this.pi.events.emit(GOAL_PROGRESS_EVENT, event);
  }

  private emitGoalBlocked(goal: ThreadGoal, ctx: GoalStatusContext): void {
    if (goal.status !== "blocked") return;
    const event: GoalBlockedEvent = {
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      goalId: goal.goalId,
      objective: goal.objective,
      blockedReason: goal.blockedReason,
    };
    this.pi.events.emit(GOAL_BLOCKED_EVENT, event);
  }

  private persistGoal(nextGoal: ThreadGoal, source: GoalEntrySource): void {
    const previousGoalId = this.goal?.goalId ?? null;
    this.goal = nextGoal;
    if (previousGoalId !== nextGoal.goalId) {
      this.clearStoppedRuntimeState();
    }

    if (
      nextGoal.status === "paused" ||
      nextGoal.status === "blocked" ||
      nextGoal.status === "complete"
    ) {
      this.clearStoppedRuntimeState();
    } else if (nextGoal.status === "budgetLimited") {
      this.clearContinuationState();
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

  private accountProgress(ctx: ExtensionContext, completedTurnTokens = 0): void {
    const canAccount = this.goal?.status === "active" || this.goal?.status === "budgetLimited";
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
      accountBudgetLimited: true,
    });
    if (!result.changed || result.goal === null) {
      return;
    }

    this.persistGoal(result.goal, "runtime");
    this.refreshUi(ctx);
  }

  private completeGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult {
    this.accountProgress(ctx, 0);
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
    this.continuationPendingAfterCompaction = false;
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

  private maybeContinue(ctx: ExtensionContext, options: MaybeContinueOptions = {}): void {
    if (
      this.goal === null ||
      this.goal.status !== "active" ||
      this.continuationQueuedFor === this.goal.goalId
    ) {
      return;
    }

    if (this.continuationBlockedByAssistantError) {
      this.continuationPendingAfterCompaction = false;
      this.blockedContinuationPosition = null;
      return;
    }

    if (
      options.resumeAnchor !== undefined &&
      !canResumeFromCompactionAnchor(ctx, options.resumeAnchor)
    ) {
      this.continuationPendingAfterCompaction = false;
      this.blockedContinuationPosition = null;
      return;
    }

    if (this.isCompacting || this.isContextNearLimit(ctx, options.allowUnknownContext === true)) {
      this.continuationPendingAfterCompaction = true;
      this.blockedContinuationPosition ??= sessionPosition(ctx);
      return;
    }

    this.continuationPendingAfterCompaction = false;
    this.blockedContinuationPosition = null;

    const goalId = this.goal.goalId;
    const goalPosition = sessionPosition(ctx);
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      if (this.continuationScheduledFor === goalId) {
        return;
      }

      this.continuationScheduledFor = goalId;
      this.continuationTimer = setTimeout(() => {
        this.continuationTimer = null;
        this.continuationScheduledFor = null;
        if (isCurrentSessionPosition(ctx, goalPosition)) {
          this.maybeContinue(ctx, options);
        }
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

  private scheduleContinuationAfterAgentSettles(ctx: ExtensionContext): void {
    if (this.isCompacting) {
      this.continuationPendingAfterCompaction = true;
      this.blockedContinuationPosition ??= sessionPosition(ctx);
      return;
    }

    if (this.postAgentSettleTimer !== null) {
      return;
    }

    this.postAgentSettlePosition = sessionPosition(ctx);
    this.postAgentSettleTimer = setTimeout(() => {
      const settlePosition = this.postAgentSettlePosition;
      this.postAgentSettleTimer = null;
      this.postAgentSettlePosition = null;
      if (settlePosition !== null && isCurrentSessionPosition(ctx, settlePosition)) {
        this.maybeContinue(ctx);
      }
    }, POST_AGENT_SETTLE_DELAY_MS);
    this.postAgentSettleTimer.unref?.();
  }

  private scheduleContinuationAfterCompaction(
    event: { compactionEntry: { id: string } },
    ctx: ExtensionContext,
  ): void {
    if (!this.continuationPendingAfterCompaction || this.compactionResumeTimer !== null) {
      return;
    }

    const blockedPosition = this.blockedContinuationPosition;
    if (blockedPosition === null || !branchContainsEntry(ctx, blockedPosition.leafId)) {
      this.continuationPendingAfterCompaction = false;
      this.blockedContinuationPosition = null;
      return;
    }

    this.compactionResumeAnchor = {
      ...sessionPosition(ctx),
      blockedLeafId: blockedPosition.leafId,
      compactionEntryId: event.compactionEntry.id,
    };
    this.compactionResumeTimer = setTimeout(() => {
      const resumeAnchor = this.compactionResumeAnchor;
      this.compactionResumeTimer = null;
      this.compactionResumeAnchor = null;
      if (resumeAnchor === null || !canResumeFromCompactionAnchor(ctx, resumeAnchor)) {
        this.continuationPendingAfterCompaction = false;
        this.blockedContinuationPosition = null;
        return;
      }
      // Pi exposes successful compaction completion to extensions via session_compact.
      // Delay one beat and re-check the branch contains both the blocked leaf and compaction entry.
      this.maybeContinue(ctx, { allowUnknownContext: true, resumeAnchor });
    }, COMPACTION_RESUME_DELAY_MS);
    this.compactionResumeTimer.unref?.();
  }

  private isContextNearLimit(ctx: ExtensionContext, allowUnknownContext: boolean): boolean {
    const usage = ctx.getContextUsage();
    const percent = usage?.percent;
    if (percent === null || percent === undefined || !Number.isFinite(percent)) {
      return !allowUnknownContext;
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
      this.continuationBlockedByAssistantError = false;
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
    this.continuationBlockedByAssistantError = false;
    this.clearContinuationState();
    this.beginAccounting();
    this.refreshUi(ctx);
  }

  private handleToolExecutionEnd(_event: object, ctx: ExtensionContext): void {
    this.accountProgress(ctx, 0);
  }

  private handleTurnEnd(event: { message: AssistantMessageLike }, ctx: ExtensionContext): void {
    const completedTurnTokens = assistantTurnTokens(event.message);
    this.accountProgress(ctx, completedTurnTokens);
    if (isAbortedAssistantMessage(event.message)) {
      this.pauseForAbort(ctx);
      return;
    }

    if (isErrorAssistantMessage(event.message)) {
      this.blockContinuationAfterAssistantError();
      this.suppressCompactionResumeIfPending();
    }
  }

  private async handleAgentEnd(
    event: { messages: AssistantMessageLike[] },
    ctx: ExtensionContext,
  ): Promise<void> {
    const abortedMessages = event.messages.filter(isAbortedAssistantMessage);
    const abortedTurnTokens = abortedMessages.reduce(
      (sum, message) => sum + assistantTurnTokens(message),
      0,
    );
    this.accountProgress(ctx, abortedTurnTokens);
    if (abortedMessages.length > 0) {
      this.pauseForAbort(ctx);
      return;
    }

    if (event.messages.some(isErrorAssistantMessage)) {
      this.blockContinuationAfterAssistantError();
      if (this.suppressCompactionResumeIfPending()) {
        return;
      }
      return;
    }

    const pruner = getContextPruneAPI(ctx);
    if (pruner?.enabled === true && pruner.pendingBatchCount() > 0) {
      await pruner.flush({ delivery: "session" });
    }
    this.scheduleContinuationAfterAgentSettles(ctx);
  }

  private handleSessionBeforeCompact(_event: object, ctx: ExtensionContext): void {
    if (this.postAgentSettleTimer !== null) {
      this.continuationPendingAfterCompaction = true;
      this.blockedContinuationPosition ??= this.postAgentSettlePosition ?? sessionPosition(ctx);
      this.clearPostAgentSettleTimer();
    }
    this.isCompacting = true;
    this.accountProgress(ctx, 0);
  }

  private handleSessionCompact(
    event: { compactionEntry: { id: string } },
    ctx: ExtensionContext,
  ): void {
    this.isCompacting = false;
    this.clearPostAgentSettleTimer();
    if (this.goal !== null) {
      this.persistGoal(this.goal, "runtime");
    }
    this.refreshUi(ctx);
    if (this.continuationPendingAfterCompaction) {
      this.scheduleContinuationAfterCompaction(event, ctx);
    }
  }

  private handleSessionShutdown(_event: object, ctx: ExtensionContext): void {
    this.isCompacting = false;
    this.accountProgress(ctx, 0);
    this.clearContinuationState();
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
      this.restoreToolState(ctx);
      return this.handleSessionStart(event, ctx);
    });
    this.pi.on("session_tree", (event, ctx) => {
      this.restoreToolState(ctx);
      this.handleSessionTree(event, ctx);
    });
    this.pi.on("before_agent_start", (event, ctx) => {
      if (!this.toolEnabled) {
        this.disableTool();
      }
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
    this.pi.on("agent_end", async (event, ctx) => {
      await this.handleAgentEnd(event, ctx);
    });
    this.pi.on("session_before_compact", (event, ctx) => {
      this.handleSessionBeforeCompact(event, ctx);
    });
    this.pi.on("session_compact", (event, ctx) => {
      this.handleSessionCompact(event, ctx);
    });
    this.pi.on("session_shutdown", (event, ctx) => {
      this.handleSessionShutdown(event, ctx);
    });
  }
}

export default function goalExtension(pi: ExtensionAPI): void {
  new GoalRuntime(pi).register();
}
