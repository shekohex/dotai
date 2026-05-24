import { Type } from "typebox";
import { Value } from "typebox/value";
import { continuationGoalIdFromPrompt } from "./prompts.js";
import { GOAL_EXTENSION_ENTRY_TYPE, type ThreadGoal } from "./types.js";

export interface GoalCustomMessageLike {
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
        Type.Literal("stale_continuation"),
      ]),
    ),
    goalId: Type.Optional(Type.String()),
    currentGoalId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    currentStatus: Type.Optional(
      Type.Union([
        Type.Literal("active"),
        Type.Literal("paused"),
        Type.Literal("blocked"),
        Type.Literal("budgetLimited"),
        Type.Literal("complete"),
        Type.Null(),
      ]),
    ),
  },
  { additionalProperties: false },
);

export function parseQueuedGoalMessageDetails(details: unknown) {
  if (!Value.Check(QueuedGoalMessageDetailsSchema, details)) {
    return null;
  }

  return Value.Parse(QueuedGoalMessageDetailsSchema, details);
}

export function staleGoalContinuationMessage(
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

export function queuedGoalWorkMessageId(message: GoalCustomMessageLike): string | null {
  if (message.customType !== GOAL_EXTENSION_ENTRY_TYPE) {
    return null;
  }

  const details = parseQueuedGoalMessageDetails(message.details);
  const { kind, goalId } = details ?? {};
  if (
    (kind === "continuation" || kind === "command_start" || kind === "command_resume") &&
    goalId !== undefined
  ) {
    return goalId;
  }

  if (typeof message.content !== "string") {
    return null;
  }

  return continuationGoalIdFromPrompt(message.content);
}
