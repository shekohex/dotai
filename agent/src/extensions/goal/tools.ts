import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { createTextComponent, formatToolRail, renderToolError } from "../coreui/tools.js";
import {
  completionUsageReport,
  formatDuration,
  formatTokenValue,
  toToolGoal,
  type GoalToolRecord,
} from "./format.js";
import { GOAL_TOOL_PROMPT_GUIDELINES } from "./prompts.js";
import { blockGoal, createGoal, unblockGoal } from "./state.js";
import {
  GOAL_MAX_OBJECTIVE_CHARS,
  type GoalEntrySource,
  type GoalResult,
  type ThreadGoal,
} from "./types.js";

const GoalToolActionSchema = Type.Union([
  Type.Literal("get"),
  Type.Literal("create"),
  Type.Literal("update"),
  Type.Literal("block"),
  Type.Literal("resume"),
]);

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
  },
  { additionalProperties: false },
);

const GoalCreateFromFileActionObjectSchema = Type.Object(
  {
    action: Type.Literal("create"),
    objectiveFile: Type.String(),
  },
  { additionalProperties: false },
);

const GoalUpdateActionObjectSchema = Type.Object(
  {
    action: Type.Literal("update"),
    status: StringEnum(["complete"] as const, {
      description: "Only complete is accepted. Do not call this until no required work remains.",
    }),
  },
  { additionalProperties: false },
);

const GoalBlockActionObjectSchema = Type.Object(
  {
    action: Type.Literal("block"),
    reason: Type.String(),
  },
  { additionalProperties: false },
);

const GoalResumeActionObjectSchema = Type.Object(
  {
    action: Type.Literal("resume"),
    reason: Type.String(),
  },
  { additionalProperties: false },
);

const GoalToolParams = Type.Object(
  {
    action: GoalToolActionSchema,
    objective: Type.Optional(
      Type.String({
        description:
          "Concrete objective to pursue until completion. Mutually exclusive with objectiveFile.",
      }),
    ),
    objectiveFile: Type.Optional(
      Type.String({
        description:
          "Absolute path to a file containing the objective to use exactly as written. Mutually exclusive with objective.",
      }),
    ),
    status: Type.Optional(
      StringEnum(["complete"] as const, {
        description: "Only complete is accepted. Do not call this until no required work remains.",
      }),
    ),
    reason: Type.Optional(
      Type.String({
        description:
          "Required for block and resume. Explain exact blocker or unblock reason with evidence and next action.",
      }),
    ),
  },
  { additionalProperties: false },
);

type GoalGetActionParams = Static<typeof GoalGetActionObjectSchema>;
type GoalCreateActionParams = Static<typeof GoalCreateActionObjectSchema>;
type GoalCreateFromFileActionParams = Static<typeof GoalCreateFromFileActionObjectSchema>;
type GoalUpdateActionParams = Static<typeof GoalUpdateActionObjectSchema>;
type GoalBlockActionParams = Static<typeof GoalBlockActionObjectSchema>;
type GoalResumeActionParams = Static<typeof GoalResumeActionObjectSchema>;
type GoalToolParamsInput = Static<typeof GoalToolParams>;

const GoalToolRecordSchema = Type.Object(
  {
    goalId: Type.String(),
    objective: Type.String(),
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("paused"),
      Type.Literal("blocked"),
      Type.Literal("budgetLimited"),
      Type.Literal("complete"),
    ]),
    tokensUsed: Type.Integer({ minimum: 0 }),
    timeUsedSeconds: Type.Integer({ minimum: 0 }),
    blockedReason: Type.Optional(Type.String()),
    blockedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    createdAt: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const GoalToolDetailsSchema = Type.Object(
  {
    action: GoalToolActionSchema,
    goal: Type.Union([GoalToolRecordSchema, Type.Null()]),
    completionUsageReport: Type.Union([Type.String(), Type.Null()]),
    error: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

type GoalToolDetails = Static<typeof GoalToolDetailsSchema>;
type GoalToolTheme = {
  fg: (token: ThemeColor, text: string) => string;
  bold: (value: string) => string;
  italic: (value: string) => string;
};

type ObjectiveResult = { ok: true; objective: string } | { ok: false; message: string };

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
    completionUsageReport: includeCompletionSummary ? completionUsageReport(goal) : null,
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

function isGoalCreateFromFileActionParams(
  params: GoalToolParamsInput,
): params is GoalCreateFromFileActionParams {
  return Value.Check(GoalCreateFromFileActionObjectSchema, params);
}

function isGoalUpdateActionParams(params: GoalToolParamsInput): params is GoalUpdateActionParams {
  return Value.Check(GoalUpdateActionObjectSchema, params);
}

function isGoalBlockActionParams(params: GoalToolParamsInput): params is GoalBlockActionParams {
  return Value.Check(GoalBlockActionObjectSchema, params);
}

function isGoalResumeActionParams(params: GoalToolParamsInput): params is GoalResumeActionParams {
  return Value.Check(GoalResumeActionObjectSchema, params);
}

function invalidCreateObjectiveSourceMessage(params: GoalToolParamsInput): string | null {
  if (params.action !== "create") {
    return null;
  }

  const sourceCount =
    Number(params.objective !== undefined) + Number(params.objectiveFile !== undefined);
  if (sourceCount === 1) {
    return null;
  }

  return "Provide exactly one objective source: objective or objectiveFile.";
}

function getGoalStatusTone(
  theme: GoalToolTheme,
  status: GoalToolRecord["status"] | "failed" | "none",
): string {
  switch (status) {
    case "complete":
      return theme.bold(theme.fg("success", "completed"));
    case "paused":
      return theme.bold(theme.fg("warning", "paused"));
    case "blocked":
      return theme.bold(theme.fg("error", "blocked"));
    case "budgetLimited":
      return theme.bold(theme.fg("warning", "paused"));
    case "active":
      return theme.bold(theme.fg("accent", "active"));
    case "failed":
      return theme.bold(theme.fg("error", "failed"));
    case "none":
      return theme.fg("muted", "not set");
    default:
      return theme.fg("muted", status);
  }
}

function formatGoalSummary(
  theme: GoalToolTheme,
  goal: GoalToolRecord | null,
  isError: boolean,
): string {
  if (goal === null) {
    return `${theme.fg("muted", "goal")} ${getGoalStatusTone(theme, isError ? "failed" : "none")}`;
  }

  const parts = [
    `${theme.fg("muted", "goal")} ${getGoalStatusTone(theme, isError ? "failed" : goal.status)}`,
    theme.fg("muted", `${formatTokenValue(goal.tokensUsed)} tokens`),
  ];
  if (goal.timeUsedSeconds > 0) {
    parts.push(theme.fg("muted", `took ${formatDuration(goal.timeUsedSeconds)}`));
  }
  return parts.join(theme.fg("muted", " · "));
}

function buildExpandedMarkdown(details: GoalToolDetails): string {
  const lines = ["# Goal"];
  if (details.goal === null) {
    lines.push("\nNo active goal.");
  } else {
    lines.push("");
    lines.push(`- Action: ${details.action}`);
    lines.push(`- Status: ${details.goal.status}`);
    lines.push(`- Objective: ${details.goal.objective}`);
    lines.push(`- Time used: ${formatDuration(details.goal.timeUsedSeconds)}`);
    lines.push(`- Tokens used: ${formatTokenValue(details.goal.tokensUsed)}`);
  }
  if (details.completionUsageReport !== null) {
    lines.push("");
    lines.push("## Completion");
    lines.push("");
    lines.push(details.completionUsageReport);
  }
  if (details.error !== null) {
    lines.push("");
    lines.push("## Error");
    lines.push("");
    lines.push(details.error);
  }

  return lines.join("\n");
}

function objectiveLinePreview(objective: string): string[] {
  return objective.split(/\r?\n/).slice(-5);
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r?\n/).length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatGoalCall(args: GoalToolParamsInput, theme: GoalToolTheme): string {
  if (args.action !== "create") {
    return `${theme.fg("muted", "goal")} ${theme.fg("accent", args.action)}`;
  }

  if (args.objective !== undefined) {
    const objective = args.objective;
    const preview = objectiveLinePreview(objective).map((line) => `  ${line}`);
    return [
      `${theme.fg("muted", "goal")} ${theme.fg("accent", "creating")} ${theme.fg("muted", `${lineCount(objective)} lines`)}`,
      ...preview,
    ].join("\n");
  }

  if (args.objectiveFile !== undefined) {
    return `${theme.fg("muted", "goal")} ${theme.fg("accent", "creating")} ${theme.fg("muted", `from ${args.objectiveFile}`)}`;
  }

  return `${theme.fg("muted", "goal")} ${theme.fg("accent", "creating")} ${theme.fg("muted", "...")}`;
}

async function resolveObjective(
  params: GoalCreateActionParams | GoalCreateFromFileActionParams,
): Promise<ObjectiveResult> {
  if ("objective" in params) {
    return { ok: true, objective: params.objective };
  }

  if (!isAbsolute(params.objectiveFile)) {
    return { ok: false, message: "objectiveFile must be an absolute path." };
  }

  let objective: string;
  try {
    objective = await readFile(params.objectiveFile, "utf8");
  } catch (error) {
    return { ok: false, message: `Failed to read objectiveFile: ${errorMessage(error)}` };
  }

  if (Array.from(objective.trim()).length > GOAL_MAX_OBJECTIVE_CHARS) {
    return {
      ok: false,
      message: `objectiveFile content must be ${GOAL_MAX_OBJECTIVE_CHARS} characters or fewer.`,
    };
  }

  return { ok: true, objective };
}

export function registerGoalTools(pi: ExtensionAPI, host: GoalToolHost): void {
  const goalTool = defineTool({
    name: "goal",
    label: "Goal",
    renderShell: "self",
    description: [
      "Inspect, create, block, resume, or update the current goal and usage for this pi session.",
      "Use action get to inspect, create to start one active goal, block only for true external blockers with a concrete reason, resume after the blocker resolves, and update only when all required work is complete.",
      ...GOAL_TOOL_PROMPT_GUIDELINES,
    ].join(" "),
    parameters: GoalToolParams,
    renderCall(args, theme, context) {
      const rail = formatToolRail(theme, context);
      return createTextComponent(context.lastComponent, `${rail}${formatGoalCall(args, theme)}`);
    },
    renderResult(result, options, theme, context) {
      const details = parseGoalToolDetails(result.details);
      if (context.isError) {
        if (!options.expanded) {
          const rail = formatToolRail(theme, context);
          return createTextComponent(
            context.lastComponent,
            `${rail}${formatGoalSummary(theme, details?.goal ?? null, true)}`,
          );
        }

        return renderToolError(details?.error ?? "goal failed", theme, context.lastComponent);
      }

      if (details === undefined) {
        return createTextComponent(context.lastComponent, "");
      }

      const rail = formatToolRail(theme, context);
      if (!options.expanded) {
        return createTextComponent(
          context.lastComponent,
          `${rail}${formatGoalSummary(theme, details.goal, false)}`,
        );
      }

      const container =
        context.lastComponent instanceof Container ? context.lastComponent : new Container();
      container.clear();
      container.addChild(
        new Markdown(buildExpandedMarkdown(details), 1, 0, getMarkdownTheme(), {
          color: (text: string) => theme.fg("toolOutput", text),
        }),
      );
      container.addChild(new Spacer(1));
      container.addChild(new Text(`${rail}${formatGoalSummary(theme, details.goal, false)}`, 1, 0));
      return container;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!Value.Check(GoalToolParams, params)) {
        return textResult("get", null, "Invalid goal tool parameters.");
      }

      const actionParams = Value.Parse(GoalToolParams, params);
      const objectiveSourceError = invalidCreateObjectiveSourceMessage(actionParams);
      if (objectiveSourceError !== null) {
        return textResult("create", null, objectiveSourceError);
      }

      if (isGoalGetActionParams(actionParams)) {
        return textResult("get", host.getGoal(), null);
      }

      if (
        isGoalCreateActionParams(actionParams) ||
        isGoalCreateFromFileActionParams(actionParams)
      ) {
        const objectiveResult = await resolveObjective(actionParams);
        if (!objectiveResult.ok) {
          return textResult("create", null, objectiveResult.message);
        }

        const result = createGoal(host.getGoal(), objectiveResult.objective);
        if (!result.ok || result.goal === null) {
          return textResult("create", result.goal, result.message);
        }

        host.setGoal(result.goal, "tool", ctx);
        return textResult("create", result.goal, null);
      }

      if (isGoalBlockActionParams(actionParams)) {
        const result = blockGoal(host.getGoal(), actionParams.reason);
        if (!result.ok || result.goal === null) {
          return textResult("block", result.goal, result.message);
        }

        host.setGoal(result.goal, "tool", ctx);
        return textResult("block", result.goal, null);
      }

      if (actionParams.action === "block") {
        return textResult("block", host.getGoal(), "Reason must not be empty.");
      }

      if (isGoalResumeActionParams(actionParams)) {
        const result = unblockGoal(host.getGoal(), actionParams.reason);
        if (!result.ok || result.goal === null) {
          return textResult("resume", result.goal, result.message);
        }

        host.setGoal(result.goal, "tool", ctx);
        return textResult("resume", result.goal, null);
      }

      if (actionParams.action === "resume") {
        return textResult("resume", host.getGoal(), "Reason must not be empty.");
      }

      if (!isGoalUpdateActionParams(actionParams)) {
        return textResult("get", null, "Invalid goal tool parameters.");
      }

      const result = host.completeGoal("tool", ctx);
      if (!result.ok || result.goal === null) {
        return textResult("update", result.goal, result.message);
      }

      return textResult("update", result.goal, null, true);
    },
  });

  pi.registerTool(goalTool);
}
