import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { createTextComponent, formatToolRail, renderToolError } from "../coreui/tools.js";
import {
  completionBudgetReport,
  formatDuration,
  formatTokenValue,
  remainingTokens,
  toToolGoal,
  type GoalToolRecord,
} from "./format.js";
import { GOAL_TOOL_PROMPT_GUIDELINES } from "./prompts.js";
import { createGoal } from "./state.js";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.js";

const GoalToolActionSchema = Type.Union([
  Type.Literal("get"),
  Type.Literal("create"),
  Type.Literal("update"),
]);

const GoalToolParams = Type.Object(
  {
    action: GoalToolActionSchema,
    objective: Type.Optional(
      Type.String({
        description: "Concrete objective to pursue until completion.",
      }),
    ),
    token_budget: Type.Optional(
      Type.Integer({
        description: "Optional positive integer token budget.",
        minimum: 1,
      }),
    ),
    status: Type.Optional(
      StringEnum(["complete"] as const, {
        description: "Only complete is accepted. Do not call this until no required work remains.",
      }),
    ),
  },
  { additionalProperties: false },
);

const GoalGetActionObjectSchema = Type.Object(
  {
    action: Type.Literal("get"),
  },
  { additionalProperties: false },
);

const GoalCreateActionObjectSchema = Type.Object(
  {
    action: Type.Literal("create"),
    objective: Type.String(),
    token_budget: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const GoalUpdateActionObjectSchema = Type.Object(
  {
    action: Type.Literal("update"),
    status: Type.Literal("complete"),
  },
  { additionalProperties: false },
);

type GoalGetActionParams = Static<typeof GoalGetActionObjectSchema>;
type GoalCreateActionParams = Static<typeof GoalCreateActionObjectSchema>;
type GoalUpdateActionParams = Static<typeof GoalUpdateActionObjectSchema>;
type GoalToolParamsInput = Static<typeof GoalToolParams>;

const GoalToolRecordSchema = Type.Object(
  {
    goalId: Type.String(),
    objective: Type.String(),
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("paused"),
      Type.Literal("budgetLimited"),
      Type.Literal("complete"),
    ]),
    tokenBudget: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    tokensUsed: Type.Integer({ minimum: 0 }),
    timeUsedSeconds: Type.Integer({ minimum: 0 }),
    createdAt: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const GoalToolDetailsSchema = Type.Object(
  {
    action: GoalToolActionSchema,
    goal: Type.Union([GoalToolRecordSchema, Type.Null()]),
    remainingTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    completionBudgetReport: Type.Union([Type.String(), Type.Null()]),
    error: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

type GoalToolDetails = Static<typeof GoalToolDetailsSchema>;
type GoalToolTheme = {
  fg: (
    token: "dim" | "muted" | "error" | "text" | "toolOutput" | "borderAccent" | "borderMuted",
    text: string,
  ) => string;
  bold: (value: string) => string;
  italic: (value: string) => string;
};

export interface GoalToolHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
}

function buildGoalToolDetails(
  action: GoalToolDetails["action"],
  goal: ThreadGoal | null,
  error: string | null,
  includeCompletionSummary = false,
): GoalToolDetails {
  return {
    action,
    goal: goal ? toToolGoal(goal) : null,
    remainingTokens: remainingTokens(goal),
    completionBudgetReport: includeCompletionSummary ? completionBudgetReport(goal) : null,
    error,
  };
}

function textResult(
  action: GoalToolDetails["action"],
  goal: ThreadGoal | null,
  error: string | null,
  includeCompletionSummary = false,
) {
  const details = buildGoalToolDetails(action, goal, error, includeCompletionSummary);
  const text = JSON.stringify(details, null, 2);
  return {
    content: [{ type: "text" as const, text: error === null ? text : `Error: ${error}` }],
    details,
  };
}

function parseGoalToolDetails(details: unknown): GoalToolDetails | undefined {
  if (!Value.Check(GoalToolDetailsSchema, details)) {
    return undefined;
  }

  return Value.Parse(GoalToolDetailsSchema, details);
}

function isGoalGetActionParams(params: GoalToolParamsInput): params is GoalGetActionParams {
  return Value.Check(GoalGetActionObjectSchema, params);
}

function isGoalCreateActionParams(params: GoalToolParamsInput): params is GoalCreateActionParams {
  return Value.Check(GoalCreateActionObjectSchema, params);
}

function isGoalUpdateActionParams(params: GoalToolParamsInput): params is GoalUpdateActionParams {
  return Value.Check(GoalUpdateActionObjectSchema, params);
}

function formatCallLabel(args: GoalToolParamsInput): string {
  if (args.action === "get") {
    return "inspect goal";
  }

  if (isGoalCreateActionParams(args)) {
    const objective = args.objective.trim();
    const budgetSuffix =
      args.token_budget === undefined ? "" : ` · ${formatTokenValue(args.token_budget)}`;
    return `${objective.length > 0 ? objective : "create goal"}${budgetSuffix}`;
  }

  return "mark complete";
}

function formatCallVerb(
  theme: GoalToolTheme,
  context: { isPartial: boolean; isError: boolean },
): string {
  if (context.isError) {
    return theme.bold(theme.fg("error", "goal"));
  }

  if (context.isPartial) {
    return theme.italic(theme.fg("muted", "goal"));
  }

  return theme.bold(theme.fg("muted", "goal"));
}

function formatGoalSummary(goal: GoalToolRecord | null): string {
  if (goal === null) {
    return "no goal set";
  }

  const parts = [goal.status, formatTokenValue(goal.tokensUsed)];
  if (goal.tokenBudget !== null) {
    parts.push(`of ${formatTokenValue(goal.tokenBudget)}`);
  }
  if (goal.timeUsedSeconds > 0) {
    parts.push(formatDuration(goal.timeUsedSeconds));
  }
  return parts.join(" · ");
}

function renderExpandedResult(theme: GoalToolTheme, details: GoalToolDetails): string {
  const lines = [`Action: ${details.action}`];
  if (details.goal === null) {
    lines.push("Goal: none");
  } else {
    lines.push(`Status: ${details.goal.status}`);
    lines.push(`Objective: ${details.goal.objective}`);
    lines.push(`Time used: ${formatDuration(details.goal.timeUsedSeconds)}`);
    lines.push(`Tokens used: ${formatTokenValue(details.goal.tokensUsed)}`);
    lines.push(
      `Token budget: ${details.goal.tokenBudget === null ? "none" : formatTokenValue(details.goal.tokenBudget)}`,
    );
    lines.push(
      `Remaining tokens: ${details.remainingTokens === null ? "unbounded" : formatTokenValue(details.remainingTokens)}`,
    );
  }
  if (details.completionBudgetReport !== null) {
    lines.push(details.completionBudgetReport);
  }

  return lines.map((line) => theme.fg("toolOutput", line)).join("\n");
}

export function registerGoalTools(pi: ExtensionAPI, host: GoalToolHost): void {
  const goalTool = defineTool({
    name: "goal",
    label: "Goal",
    renderShell: "self",
    description: "Inspect, create, or update the current goal and usage for this pi session.",
    promptSnippet:
      "Use action get to inspect goal, action create to start one active goal, and action update only to mark completed goal complete.",
    promptGuidelines: [...GOAL_TOOL_PROMPT_GUIDELINES],
    parameters: GoalToolParams,
    renderCall(args, theme, context) {
      const rail = formatToolRail(theme, context);
      return createTextComponent(
        context.lastComponent,
        `${rail}${formatCallVerb(theme, context)} ${theme.fg("text", formatCallLabel(args))}`,
      );
    },
    renderResult(result, options, theme, context) {
      const details = parseGoalToolDetails(result.details);
      if (context.isError) {
        return renderToolError(details?.error ?? "goal failed", theme, context.lastComponent);
      }

      if (details === undefined) {
        return createTextComponent(context.lastComponent, "");
      }

      const rail = formatToolRail(theme, context);
      if (!options.expanded) {
        return createTextComponent(
          context.lastComponent,
          `${rail}${theme.fg("dim", "↳ ")}${theme.fg("muted", formatGoalSummary(details.goal))}`,
        );
      }

      return createTextComponent(
        context.lastComponent,
        `${renderExpandedResult(theme, details)}\n${rail}${theme.fg("dim", "↳ ")}${theme.fg("muted", formatGoalSummary(details.goal))}`,
      );
    },
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!Value.Check(GoalToolParams, params)) {
        return Promise.resolve(textResult("get", null, "Invalid goal tool parameters."));
      }

      const actionParams = Value.Parse(GoalToolParams, params);

      if (isGoalGetActionParams(actionParams)) {
        return Promise.resolve(textResult("get", host.getGoal(), null));
      }

      if (isGoalCreateActionParams(actionParams)) {
        const result = createGoal(
          host.getGoal(),
          actionParams.objective,
          actionParams.token_budget ?? null,
        );
        if (!result.ok || result.goal === null) {
          return Promise.resolve(textResult("create", result.goal, result.message));
        }

        host.setGoal(result.goal, "tool", ctx);
        return Promise.resolve(textResult("create", result.goal, null));
      }

      if (!isGoalUpdateActionParams(actionParams)) {
        return Promise.resolve(textResult("get", null, "Invalid goal tool parameters."));
      }

      const result = host.completeGoal("tool", ctx);
      if (!result.ok || result.goal === null) {
        return Promise.resolve(textResult("update", result.goal, result.message));
      }

      return Promise.resolve(textResult("update", result.goal, null, true));
    },
  });

  pi.registerTool(goalTool);
}
