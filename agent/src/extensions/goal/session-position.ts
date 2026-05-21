import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface GoalStatusContext {
  ui: Pick<ExtensionContext["ui"], "setStatus">;
  cwd: string;
  sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getBranch" | "getLeafId" | "getSessionId"
  >;
}

export interface GoalSessionPosition {
  sessionId: string;
  leafId: string | null;
}

export interface GoalCompactionResumeAnchor extends GoalSessionPosition {
  blockedLeafId: string | null;
  compactionEntryId: string;
}

export interface MaybeContinueOptions {
  allowUnknownContext?: boolean;
  resumeAnchor?: GoalCompactionResumeAnchor;
}

export function sessionPosition(ctx: GoalStatusContext): GoalSessionPosition {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    leafId: ctx.sessionManager.getLeafId(),
  };
}

export function isCurrentSessionPosition(
  ctx: GoalStatusContext,
  position: GoalSessionPosition,
): boolean {
  try {
    const currentPosition = sessionPosition(ctx);
    return (
      currentPosition.sessionId === position.sessionId && currentPosition.leafId === position.leafId
    );
  } catch {
    return false;
  }
}

export function branchContainsEntry(ctx: GoalStatusContext, entryId: string | null): boolean {
  if (entryId === null) {
    return true;
  }

  return ctx.sessionManager.getBranch().some((entry) => entry.id === entryId);
}

export function canResumeFromCompactionAnchor(
  ctx: GoalStatusContext,
  anchor: GoalCompactionResumeAnchor,
): boolean {
  try {
    return (
      ctx.sessionManager.getSessionId() === anchor.sessionId &&
      ctx.sessionManager.getLeafId() === anchor.leafId &&
      branchContainsEntry(ctx, anchor.blockedLeafId) &&
      branchContainsEntry(ctx, anchor.compactionEntryId)
    );
  } catch {
    return false;
  }
}
