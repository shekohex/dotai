import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  GOAL_EXTENSION_ENTRY_TYPE,
  GOAL_MAX_OBJECTIVE_CHARS,
  GoalCustomEntrySchema,
  type GoalCustomEntry,
  type GoalEntrySource,
  type GoalWorkflowCounters,
  type GoalResult,
  type GoalWorkflowMetadata,
  type GoalSnapshot,
  type SessionEntryLike,
  type ThreadGoal,
} from "./types.js";

type DirectGoalStatusUpdate = Exclude<ThreadGoal["status"], "blocked">;
type GoalLifecycleMessagePi = Pick<ExtensionAPI, "sendMessage">;

export interface ApplyUsageOptions {
  expectedGoalId?: string | null;
  accountBudgetLimited?: boolean;
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function sendVisibleGoalMessage(
  pi: GoalLifecycleMessagePi,
  content: string,
  details: Record<string, unknown>,
): void {
  pi.sendMessage(
    {
      customType: GOAL_EXTENSION_ENTRY_TYPE,
      content,
      display: true,
      details,
    },
    { triggerTurn: false },
  );
}

export function cloneGoal(goal: ThreadGoal): ThreadGoal {
  return {
    ...goal,
    usage: { ...goal.usage },
  };
}

export function validateObjective(objective: string): string | null {
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    return "Objective must not be empty.";
  }

  if (Array.from(trimmed).length > GOAL_MAX_OBJECTIVE_CHARS) {
    return `Objective must be ${GOAL_MAX_OBJECTIVE_CHARS} characters or fewer.`;
  }

  return null;
}

export function createThreadGoal(objective: string, now = unixSeconds()): ThreadGoal {
  return {
    goalId: randomUUID(),
    objective: objective.trim(),
    status: "active",
    tokenBudget: null,
    usage: {
      tokensUsed: 0,
      activeSeconds: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function setEntry(
  goal: ThreadGoal,
  source: GoalEntrySource,
  at = unixSeconds(),
): GoalCustomEntry {
  return {
    version: 1,
    kind: "set",
    source,
    goal: cloneGoal(goal),
    at,
  };
}

export function clearEntry(
  clearedGoalId: string | null,
  source: GoalEntrySource,
  at = unixSeconds(),
): GoalCustomEntry {
  return {
    version: 1,
    kind: "clear",
    source,
    clearedGoalId,
    at,
  };
}

export function parseGoalCustomEntry(data: unknown): GoalCustomEntry | null {
  if (!Value.Check(GoalCustomEntrySchema, data)) {
    return null;
  }

  return Value.Parse(GoalCustomEntrySchema, data);
}

export function reconstructGoal(entries: Iterable<SessionEntryLike>): GoalSnapshot {
  let goal: ThreadGoal | null = null;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== GOAL_EXTENSION_ENTRY_TYPE) {
      continue;
    }

    const customEntry = parseGoalCustomEntry(entry.data);
    if (customEntry === null) {
      continue;
    }

    if (customEntry.kind === "clear") {
      goal = null;
      continue;
    }

    goal = cloneGoal(customEntry.goal);
  }

  return {
    goal,
    hasGoal: goal !== null,
  };
}

export function createGoal(current: ThreadGoal | null, objective: string): GoalResult {
  if (current !== null && current.status !== "complete") {
    return {
      ok: false,
      message:
        "cannot create a new goal because this thread already has a goal; clear the current goal first or complete it before starting a new one",
      goal: current,
    };
  }

  const objectiveError = validateObjective(objective);
  if (objectiveError !== null) {
    return { ok: false, message: objectiveError, goal: null };
  }

  return {
    ok: true,
    message: "Goal created.",
    goal: createThreadGoal(objective),
  };
}

export function replaceGoal(objective: string): GoalResult {
  const objectiveError = validateObjective(objective);
  if (objectiveError !== null) {
    return { ok: false, message: objectiveError, goal: null };
  }

  return {
    ok: true,
    message: "Goal set.",
    goal: createThreadGoal(objective),
  };
}

export function replaceWorkflowGoal(objective: string, workflow: GoalWorkflowMetadata): GoalResult {
  const result = replaceGoal(objective);
  if (!result.ok || result.goal === null) return result;
  return { ...result, goal: { ...result.goal, workflow } };
}

export function addGoalWorkflowUsage(
  goal: ThreadGoal,
  usage: { tokens?: number; activeSeconds?: number },
): ThreadGoal {
  return {
    ...cloneGoal(goal),
    usage: {
      tokensUsed: goal.usage.tokensUsed + Math.max(0, Math.floor(usage.tokens ?? 0)),
      activeSeconds: goal.usage.activeSeconds + Math.max(0, Math.floor(usage.activeSeconds ?? 0)),
    },
    updatedAt: unixSeconds(),
  };
}

export function updateGoalWorkflowCounters(
  goal: ThreadGoal,
  counters: GoalWorkflowCounters | undefined,
): ThreadGoal {
  if (goal.workflow === undefined || counters === undefined) return goal;
  return {
    ...cloneGoal(goal),
    workflow: {
      ...goal.workflow,
      counters,
    },
    updatedAt: unixSeconds(),
  };
}

export function updateGoalStatus(
  current: ThreadGoal | null,
  status: DirectGoalStatusUpdate,
): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  if (current.status === "blocked") {
    return {
      ok: false,
      message: "Blocked goals must be unblocked before changing status.",
      goal: current,
    };
  }

  const goal = cloneGoal(current);
  goal.status = status;
  goal.updatedAt = unixSeconds();

  return {
    ok: true,
    message: `Goal marked ${goal.status}.`,
    goal,
  };
}

export function validateBlockReason(reason: string): string | null {
  const trimmedReason = reason.trim();
  if (trimmedReason.length === 0) {
    return "Reason must not be empty.";
  }

  if (trimmedReason.length < 50) {
    return "Reason must describe the concrete blocker and needed unblock action.";
  }

  return null;
}

export function validateUnblockReason(reason: string): string | null {
  if (reason.trim().length === 0) {
    return "Reason must not be empty.";
  }

  return null;
}

export function blockGoal(current: ThreadGoal | null, reason: string): GoalResult {
  const reasonError = validateBlockReason(reason);
  if (reasonError !== null) {
    return { ok: false, message: reasonError, goal: current };
  }

  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  if (current.status !== "active") {
    return {
      ok: false,
      message: "Only active goals can be blocked.",
      goal: current,
    };
  }

  const now = unixSeconds();
  const goal: ThreadGoal = {
    ...cloneGoal(current),
    status: "blocked",
    blockedReason: reason.trim(),
    blockedAt: now,
    updatedAt: now,
  };

  return {
    ok: true,
    message: "Goal blocked.",
    goal,
  };
}

export function unblockGoal(current: ThreadGoal | null, reason: string): GoalResult {
  const reasonError = validateUnblockReason(reason);
  if (reasonError !== null) {
    return { ok: false, message: reasonError, goal: current };
  }

  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  if (current.status !== "blocked") {
    return {
      ok: false,
      message: "Only blocked goals can be unblocked.",
      goal: current,
    };
  }

  const now = unixSeconds();
  const {
    blockedAt: _blockedAt,
    blockedReason: _blockedReason,
    ...goalWithoutBlockedMetadata
  } = current;
  const goal: ThreadGoal = {
    ...goalWithoutBlockedMetadata,
    status: "active",
    resumedReason: reason.trim(),
    resumedAt: now,
    updatedAt: now,
  };

  return {
    ok: true,
    message: "Goal resumed.",
    goal,
  };
}

export function applyUsage(
  current: ThreadGoal | null,
  tokensDelta: number,
  activeSecondsDelta: number,
  options: ApplyUsageOptions = {},
): { goal: ThreadGoal | null; changed: boolean } {
  if (!current) {
    return { goal: current, changed: false };
  }

  if (
    options.expectedGoalId !== undefined &&
    options.expectedGoalId !== null &&
    current.goalId !== options.expectedGoalId
  ) {
    return { goal: current, changed: false };
  }

  const canAccount =
    current.status === "active" ||
    (options.accountBudgetLimited === true && current.status === "budgetLimited");
  if (!canAccount) {
    return { goal: current, changed: false };
  }

  const tokens = Math.max(0, Math.trunc(tokensDelta));
  const seconds = Math.max(0, Math.trunc(activeSecondsDelta));
  if (tokens === 0 && seconds === 0) {
    return { goal: current, changed: false };
  }

  const goal = cloneGoal(current);
  goal.usage.tokensUsed += tokens;
  goal.usage.activeSeconds += seconds;
  goal.updatedAt = unixSeconds();

  return { goal, changed: true };
}

export function goalWithLiveUsage(
  current: ThreadGoal | null,
  activeGoalId: string | null,
  lastAccountedAt: number | null,
  now = Date.now(),
): ThreadGoal | null {
  if (
    !current ||
    current.status !== "active" ||
    activeGoalId !== current.goalId ||
    lastAccountedAt === null
  ) {
    return current;
  }

  const liveSeconds = Math.max(0, Math.floor((now - lastAccountedAt) / 1000));
  if (liveSeconds === 0) {
    return current;
  }

  const goal = cloneGoal(current);
  goal.usage.activeSeconds += liveSeconds;
  return goal;
}
