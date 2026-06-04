import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { formatGoalSummary } from "./format.js";
import { continuationPrompt } from "./prompts.js";
import {
  blockGoal,
  replaceGoal,
  sendVisibleGoalMessage,
  unblockGoal,
  updateGoalStatus,
} from "./state.js";
import {
  GOAL_EXTENSION_ENTRY_TYPE,
  GOAL_MAX_OBJECTIVE_CHARS,
  type GoalEntrySource,
  type ThreadGoal,
} from "./types.js";
const GOAL_COMMAND_AUTOCOMPLETE_ITEMS: AutocompleteItem[] = [
  {
    value: "on",
    label: "on",
    description: "Enable goal tool",
  },
  {
    value: "workflow",
    label: "workflow",
    description: "Run current goal via bundled workflow orchestration",
  },
  {
    value: "off",
    label: "off",
    description: "Disable goal tool",
  },
  {
    value: "pause",
    label: "pause",
    description: "Pause active goal and stop auto-continuation",
  },
  {
    value: "resume",
    label: "resume",
    description: "Resume paused goal and queue follow-up work",
  },
  {
    value: "block",
    label: "block",
    description: "Block active goal with reason",
  },
  {
    value: "unblock",
    label: "unblock",
    description: "Unblock blocked goal and queue follow-up work",
  },
  {
    value: "clear",
    label: "clear",
    description: "Clear current goal from session state",
  },
];

const GOAL_WORKFLOW_AUTOCOMPLETE_ITEMS: AutocompleteItem[] = [
  { value: "workflow start ", label: "workflow start", description: "Start workflow goal" },
  { value: "workflow resume", label: "workflow resume", description: "Resume workflow goal" },
  {
    value: "workflow unblock ",
    label: "workflow unblock",
    description: "Unblock workflow goal with reason",
  },
  { value: "workflow status", label: "workflow status", description: "Show workflow goal status" },
  {
    value: "workflow @",
    label: "workflow @file",
    description: "Start workflow goal from objective file",
  },
];

export type GoalCommandPi = Pick<ExtensionAPI, "registerCommand" | "sendMessage">;

export interface GoalCommandContext {
  cwd: string;
  hasUI: boolean;
  sessionManager: Pick<
    ExtensionCommandContext["sessionManager"],
    "getBranch" | "getLeafId" | "getSessionId"
  >;
  ui: Pick<ExtensionCommandContext["ui"], "confirm" | "input" | "notify" | "setStatus">;
}

type GoalCommandObjective =
  | {
      ok: true;
      objective: string;
      label: string;
      source: "inline" | "file";
      objectiveFile?: string;
    }
  | { ok: false; message: string };

export interface GoalCommandHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: GoalCommandContext): void;
  clearGoal(source: GoalEntrySource, ctx: GoalCommandContext): void;
  enableTool(ctx: GoalCommandContext): void;
  disableTool(ctx: GoalCommandContext): void;
  startWorkflowGoal(
    objective: GoalCommandObjective & { ok: true },
    ctx: ExtensionCommandContext,
  ): Promise<void>;
  resumeWorkflowGoal(ctx: ExtensionCommandContext, reason?: string): Promise<void>;
}

function goalCommandCompletions(prefix: string): AutocompleteItem[] {
  if (prefix === "workflow" || prefix.startsWith("workflow ")) {
    return GOAL_WORKFLOW_AUTOCOMPLETE_ITEMS.filter((item) => item.value.startsWith(prefix));
  }
  return GOAL_COMMAND_AUTOCOMPLETE_ITEMS.filter((item) => item.value.startsWith(prefix));
}

function queueGoalTurn(
  pi: GoalCommandPi,
  goal: ThreadGoal,
  kind: "command_start" | "command_resume",
  resumedReason?: string,
): void {
  pi.sendMessage(
    {
      customType: GOAL_EXTENSION_ENTRY_TYPE,
      content: continuationPrompt(goal, resumedReason),
      display: false,
      details: { kind, goalId: goal.goalId },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

async function resolveInlineOrPromptedReason(
  inlineReason: string,
  title: string,
  placeholder: string,
  ctx: GoalCommandContext,
): Promise<string | null> {
  const trimmedReason = inlineReason.trim();
  if (trimmedReason.length > 0) {
    return trimmedReason;
  }

  if (!ctx.hasUI) {
    return null;
  }

  const promptedReason = await ctx.ui.input(title, placeholder);
  return promptedReason?.trim() ?? null;
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value.at(0);
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }

  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseGoalObjectiveFileReference(input: string): string | null {
  if (!input.startsWith("@")) {
    return null;
  }

  return stripWrappingQuotes(input.slice(1).trim());
}

function objectiveFilePath(rawPath: string, cwd: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
}

async function resolveGoalCommandObjective(
  trimmed: string,
  ctx: GoalCommandContext,
  options: { enforceMaxObjectiveChars?: boolean } = {},
): Promise<GoalCommandObjective> {
  const rawObjectiveFile = parseGoalObjectiveFileReference(trimmed);
  if (rawObjectiveFile === null) {
    return { ok: true, objective: trimmed, label: trimmed, source: "inline" };
  }

  if (rawObjectiveFile.length === 0) {
    return { ok: false, message: "Objective file path must follow @." };
  }

  const absolutePath = objectiveFilePath(rawObjectiveFile, ctx.cwd);
  let objective: string;
  try {
    objective = await readFile(absolutePath, "utf8");
  } catch (error) {
    return { ok: false, message: `Failed to read objective file: ${errorMessage(error)}` };
  }

  if (
    options.enforceMaxObjectiveChars !== false &&
    Array.from(objective.trim()).length > GOAL_MAX_OBJECTIVE_CHARS
  ) {
    return {
      ok: false,
      message: `Objective file content must be ${GOAL_MAX_OBJECTIVE_CHARS} characters or fewer.`,
    };
  }

  return {
    ok: true,
    objective,
    label: `@${absolutePath}`,
    source: "file",
    objectiveFile: absolutePath,
  };
}

function workflowObjectiveArgs(trimmed: string): string | null {
  if (trimmed === "workflow") return "";
  if (!trimmed.startsWith("workflow ")) return null;
  return trimmed.slice("workflow".length).trim();
}

function workflowStartArgs(workflowArgs: string): string {
  if (workflowArgs.startsWith("start ")) return workflowArgs.slice("start".length).trim();
  return workflowArgs;
}

async function handleGoalWorkflowCommand(
  host: GoalCommandHost,
  workflowArgs: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (workflowArgs.length === 0) {
    ctx.ui.notify(
      "Usage: /goal workflow start <objective|@objective-file>, resume, unblock <reason>, or status",
      "warning",
    );
    return;
  }
  if (workflowArgs === "status") {
    ctx.ui.notify(formatGoalSummary(host.getGoal()));
    return;
  }
  if (workflowArgs === "resume") {
    await host.resumeWorkflowGoal(ctx);
    return;
  }
  if (workflowArgs === "unblock" || workflowArgs.startsWith("unblock ")) {
    const reason = await resolveInlineOrPromptedReason(
      workflowArgs.slice("unblock".length),
      "Unblock workflow goal",
      "What changed externally?",
      ctx,
    );
    if (reason === null || reason.length === 0) {
      ctx.ui.notify("Unblock reason is required.", "warning");
      return;
    }
    await host.resumeWorkflowGoal(ctx, reason);
    return;
  }
  if (workflowArgs === "start") {
    ctx.ui.notify("Usage: /goal workflow start <objective|@objective-file>", "warning");
    return;
  }
  const startArgs = workflowStartArgs(workflowArgs);
  const objectiveResult = await resolveGoalCommandObjective(startArgs, ctx, {
    enforceMaxObjectiveChars: false,
  });
  if (!objectiveResult.ok) {
    ctx.ui.notify(objectiveResult.message, "error");
    return;
  }
  await host.startWorkflowGoal(objectiveResult, ctx);
}

async function handleGoalPauseOrResumeCommand(
  pi: GoalCommandPi,
  host: GoalCommandHost,
  command: "pause" | "resume",
  ctx: ExtensionCommandContext,
): Promise<void> {
  const current = host.getGoal();
  if (command === "resume" && current?.workflow !== undefined) {
    await host.resumeWorkflowGoal(ctx);
    return;
  }

  if (command === "pause" && current?.status === "blocked") {
    ctx.ui.notify("Goal is already blocked. Use /goal unblock <reason> to resume.", "warning");
    return;
  }

  if (command === "resume" && current?.status === "blocked") {
    ctx.ui.notify("Use /goal unblock <reason> to resume blocked goals.", "warning");
    return;
  }

  const status = command === "pause" ? "paused" : "active";
  const result = updateGoalStatus(current, status);
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "warning");
    return;
  }

  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
  if (command === "pause") {
    sendVisibleGoalMessage(pi, `Goal paused. Goal ID: ${result.goal.goalId}`, {
      kind: "goal-paused",
      goalId: result.goal.goalId,
      reason: "user requested /goal pause",
    });
  }
  if (command === "resume" && result.goal.status === "active") {
    queueGoalTurn(pi, result.goal, "command_resume");
  }
}

async function handleGoalUnblockCommand(
  pi: GoalCommandPi,
  host: GoalCommandHost,
  trimmed: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const reason = await resolveInlineOrPromptedReason(
    trimmed.slice("unblock".length),
    "Unblock goal",
    "What changed?",
    ctx,
  );
  if (reason === null || reason.length === 0) {
    ctx.ui.notify("Unblock reason is required.", "warning");
    return;
  }

  const current = host.getGoal();
  if (current?.workflow !== undefined) {
    await host.resumeWorkflowGoal(ctx, reason);
    return;
  }

  const result = unblockGoal(current, reason);
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "warning");
    return;
  }

  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
  queueGoalTurn(pi, result.goal, "command_resume", reason);
}

export async function handleGoalCommand(
  pi: GoalCommandPi,
  host: GoalCommandHost,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const trimmed = args.trim();
  if (trimmed === "off") {
    host.disableTool(ctx);
    ctx.ui.notify("Goal tool disabled.");
    return;
  }

  host.enableTool(ctx);

  if (trimmed === "on") {
    ctx.ui.notify("Goal tool enabled.");
    return;
  }

  if (trimmed.length === 0) {
    ctx.ui.notify(formatGoalSummary(host.getGoal()));
    return;
  }

  const workflowArgs = workflowObjectiveArgs(trimmed);
  if (workflowArgs !== null) {
    await handleGoalWorkflowCommand(host, workflowArgs, ctx);
    return;
  }

  if (trimmed === "clear") {
    const goal = host.getGoal();
    if (!goal) {
      ctx.ui.notify("No goal is set.", "warning");
      return;
    }

    host.clearGoal("command", ctx);
    ctx.ui.notify("Goal cleared.");
    return;
  }

  if (trimmed === "pause" || trimmed === "resume") {
    await handleGoalPauseOrResumeCommand(pi, host, trimmed, ctx);
    return;
  }

  if (trimmed === "block" || trimmed.startsWith("block ")) {
    const reason = trimmed.slice("block".length).trim();
    const result = blockGoal(host.getGoal(), reason);
    if (!result.ok || !result.goal) {
      ctx.ui.notify(result.message, "warning");
      return;
    }

    host.setGoal(result.goal, "command", ctx);
    ctx.ui.notify(result.message);
    return;
  }

  if (trimmed === "unblock" || trimmed.startsWith("unblock ")) {
    await handleGoalUnblockCommand(pi, host, trimmed, ctx);
    return;
  }

  const objectiveResult = await resolveGoalCommandObjective(trimmed, ctx);
  if (!objectiveResult.ok) {
    ctx.ui.notify(objectiveResult.message, "error");
    return;
  }

  const current = host.getGoal();
  if (current && current.status !== "complete") {
    if (!ctx.hasUI) {
      ctx.ui.notify("Clear existing goal before replacing it.", "error");
      return;
    }

    const shouldReplace = await ctx.ui.confirm(
      "Replace goal?",
      `Current goal:\n${current.objective}\n\nNew goal:\n${objectiveResult.label}`,
    );
    if (!shouldReplace) {
      ctx.ui.notify("Goal unchanged.");
      return;
    }
  }

  const result = replaceGoal(objectiveResult.objective);
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "error");
    return;
  }

  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
  queueGoalTurn(pi, result.goal, "command_start");
}

export function registerGoalCommand(pi: GoalCommandPi, host: GoalCommandHost): void {
  pi.registerCommand("goal", {
    description: "Show or manage current Codex-style goal.",
    getArgumentCompletions(argumentPrefix) {
      return goalCommandCompletions(argumentPrefix.trim());
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      await handleGoalCommand(pi, host, args, ctx);
    },
  });
}
