import { Type, type Static } from "typebox";

export const GOAL_EXTENSION_ENTRY_TYPE = "goal";
export const GOAL_STATUS_KEY = "goal";
export const GOAL_MAX_OBJECTIVE_CHARS = 8000;

export const GoalStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
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

export const ThreadGoalSchema = Type.Object(
  {
    goalId: Type.String(),
    objective: Type.String(),
    status: GoalStatusSchema,
    tokenBudget: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    usage: GoalUsageSchema,
    createdAt: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

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

export type GoalStatus = Static<typeof GoalStatusSchema>;
export type GoalUsage = Static<typeof GoalUsageSchema>;
export type ThreadGoal = Static<typeof ThreadGoalSchema>;
export type GoalEntrySource = Static<typeof GoalEntrySourceSchema>;
export type GoalCustomEntry = Static<typeof GoalCustomEntrySchema>;

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
