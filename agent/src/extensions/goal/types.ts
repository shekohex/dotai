import { Type, type Static } from "typebox";

export const GOAL_EXTENSION_ENTRY_TYPE = "goal";
export const GOAL_STATUS_KEY = "goal";
export const GOAL_MAX_OBJECTIVE_CHARS = 8000;
export const GOAL_PROGRESS_EVENT = "goal:progress";
export const GOAL_BLOCKED_EVENT = "goal:blocked";

export const GoalStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("blocked"),
  Type.Literal("budgetLimited"),
  Type.Literal("complete"),
]);

export const GoalUsageSchema = Type.Object(
  {
    tokensUsed: Type.Integer({ minimum: 0 }),
    activeSeconds: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const GoalWorkflowMetadataSchema = Type.Object(
  {
    runId: Type.String(),
    workflowName: Type.String(),
    objectiveSource: Type.Union([Type.Literal("inline"), Type.Literal("file")]),
    objectiveFile: Type.Optional(Type.String()),
    startCommit: Type.String(),
    startedAt: Type.String(),
  },
  { additionalProperties: false },
);

const ThreadGoalBaseProperties = {
  goalId: Type.String(),
  objective: Type.String(),
  tokenBudget: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  usage: GoalUsageSchema,
  workflow: Type.Optional(GoalWorkflowMetadataSchema),
  resumedReason: Type.Optional(Type.String()),
  resumedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  createdAt: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Integer({ minimum: 0 }),
};

const NonBlockedThreadGoalSchema = Type.Object(
  {
    ...ThreadGoalBaseProperties,
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("paused"),
      Type.Literal("budgetLimited"),
      Type.Literal("complete"),
    ]),
  },
  { additionalProperties: false },
);

const BlockedThreadGoalSchema = Type.Object(
  {
    ...ThreadGoalBaseProperties,
    status: Type.Literal("blocked"),
    blockedReason: Type.String({ pattern: ".*\\S.*" }),
    blockedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ThreadGoalSchema = Type.Union([NonBlockedThreadGoalSchema, BlockedThreadGoalSchema]);

export const GoalEntrySourceSchema = Type.Union([
  Type.Literal("command"),
  Type.Literal("tool"),
  Type.Literal("runtime"),
]);

export const GoalSetEntrySchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("set"),
    source: GoalEntrySourceSchema,
    goal: ThreadGoalSchema,
    at: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const GoalClearEntrySchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("clear"),
    source: GoalEntrySourceSchema,
    clearedGoalId: Type.Union([Type.String(), Type.Null()]),
    at: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const GoalCustomEntrySchema = Type.Union([GoalSetEntrySchema, GoalClearEntrySchema]);

export const GoalProgressEventSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("active"), Type.Literal("clear")]),
    sessionId: Type.String(),
    cwd: Type.String(),
    timeUsedSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const GoalBlockedEventSchema = Type.Object(
  {
    sessionId: Type.String(),
    cwd: Type.String(),
    goalId: Type.String(),
    objective: Type.String(),
    blockedReason: Type.String(),
  },
  { additionalProperties: false },
);

export type GoalStatus = Static<typeof GoalStatusSchema>;
export type GoalUsage = Static<typeof GoalUsageSchema>;
export type GoalWorkflowMetadata = Static<typeof GoalWorkflowMetadataSchema>;
export type ThreadGoal = Static<typeof ThreadGoalSchema>;
export type GoalEntrySource = Static<typeof GoalEntrySourceSchema>;
export type GoalCustomEntry = Static<typeof GoalCustomEntrySchema>;
export type GoalProgressEvent = Static<typeof GoalProgressEventSchema>;
export type GoalBlockedEvent = Static<typeof GoalBlockedEventSchema>;

export interface GoalResult {
  ok: boolean;
  message: string;
  goal: ThreadGoal | null;
}

export interface GoalSnapshot {
  goal: ThreadGoal | null;
  hasGoal: boolean;
}

export interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}
