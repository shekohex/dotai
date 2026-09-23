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
    const branch = ctx.sessionManager.getBranch();
    const leafId = ctx.sessionManager.getLeafId();
    const anchorIndex = branch.findIndex((entry) => entry.id === anchor.leafId);
    // Silent extension reminders can append after compaction without starting a turn.
    const onlySilentMessagesAppended =
      anchorIndex >= 0 &&
      branch.at(-1)?.id === leafId &&
      branch
        .slice(anchorIndex + 1)
        .every((entry) => entry.type === "custom_message" && !entry.display);
    return (
      ctx.sessionManager.getSessionId() === anchor.sessionId &&
      (leafId === anchor.leafId || onlySilentMessagesAppended) &&
      (anchor.blockedLeafId === null ||
        branch.some((entry) => entry.id === anchor.blockedLeafId)) &&
      branch.some((entry) => entry.id === anchor.compactionEntryId)
    );
  } catch {
    return false;
  }
}
