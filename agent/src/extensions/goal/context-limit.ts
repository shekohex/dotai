import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface GoalContextLimitState {
  warningQueuedFor: string | null;
  warningDeliveredFor: string | null;
}

export const CONTEXT_LIMIT_USAGE_PERCENT_LIMIT = 90;
export const CONTINUATION_CONTEXT_USAGE_PERCENT_LIMIT = 95;

export function createGoalContextLimitState(): GoalContextLimitState {
  return {
    warningQueuedFor: null,
    warningDeliveredFor: null,
  };
}

export function resetGoalContextLimitState(state: GoalContextLimitState): void {
  state.warningQueuedFor = null;
  state.warningDeliveredFor = null;
}

export function markContextLimitWarningQueued(state: GoalContextLimitState, goalId: string): void {
  state.warningQueuedFor = goalId;
  state.warningDeliveredFor = null;
}

export function markContextLimitWarningDelivered(
  state: GoalContextLimitState,
  goalId: string,
): void {
  state.warningDeliveredFor = goalId;
}

export function hasContextLimitWarningQueued(
  state: GoalContextLimitState,
  goalId: string,
): boolean {
  return state.warningQueuedFor === goalId;
}

export function hasContextLimitWarningDelivered(
  state: GoalContextLimitState,
  goalId: string,
): boolean {
  return state.warningDeliveredFor === goalId;
}

export function contextUsagePercent(ctx: ExtensionContext): number | null {
  const usage = ctx.getContextUsage();
  const percent = usage?.percent;
  if (percent === null || percent === undefined || !Number.isFinite(percent)) {
    return null;
  }

  return percent;
}

export function isContextLimitWarningActive(ctx: ExtensionContext): boolean {
  const percent = contextUsagePercent(ctx);
  return percent !== null && percent >= CONTEXT_LIMIT_USAGE_PERCENT_LIMIT;
}

export function isContinuationContextNearLimit(ctx: ExtensionContext): boolean {
  const percent = contextUsagePercent(ctx);
  return percent !== null && percent >= CONTINUATION_CONTEXT_USAGE_PERCENT_LIMIT;
}
