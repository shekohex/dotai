import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { formatGoalSummary } from "./format.js";
import { continuationPrompt } from "./prompts.js";
import { replaceGoal, updateGoalStatus } from "./state.js";
import { GOAL_EXTENSION_ENTRY_TYPE, type GoalEntrySource, type ThreadGoal } from "./types.js";
const GOAL_COMMAND_AUTOCOMPLETE_ITEMS: AutocompleteItem[] = [
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
    value: "clear",
    label: "clear",
    description: "Clear current goal from session state",
  },
];

export type GoalCommandPi = Pick<ExtensionAPI, "registerCommand" | "sendMessage">;

export interface GoalCommandContext {
  hasUI: boolean;
  ui: Pick<ExtensionCommandContext["ui"], "confirm" | "notify" | "setStatus">;
}

export interface GoalCommandHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: GoalCommandContext): void;
  clearGoal(source: GoalEntrySource, ctx: GoalCommandContext): void;
}

function goalCommandCompletions(prefix: string): AutocompleteItem[] {
  return GOAL_COMMAND_AUTOCOMPLETE_ITEMS.filter((item) => item.value.startsWith(prefix));
}

function queueGoalTurn(
  pi: GoalCommandPi,
  goal: ThreadGoal,
  kind: "command_start" | "command_resume",
): void {
  pi.sendMessage(
    {
      customType: GOAL_EXTENSION_ENTRY_TYPE,
      content: continuationPrompt(goal),
      display: false,
      details: { kind, goalId: goal.goalId },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

export async function handleGoalCommand(
  pi: GoalCommandPi,
  host: GoalCommandHost,
  args: string,
  ctx: GoalCommandContext,
): Promise<void> {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    ctx.ui.notify(formatGoalSummary(host.getGoal()));
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
    const current = host.getGoal();
    const status = trimmed === "pause" ? "paused" : "active";
    const result = updateGoalStatus(current, status);
    if (!result.ok || !result.goal) {
      ctx.ui.notify(result.message, "warning");
      return;
    }

    host.setGoal(result.goal, "command", ctx);
    ctx.ui.notify(result.message);
    if (trimmed === "resume" && result.goal.status === "active") {
      queueGoalTurn(pi, result.goal, "command_resume");
    }
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
      `Current goal:\n${current.objective}\n\nNew goal:\n${trimmed}`,
    );
    if (!shouldReplace) {
      ctx.ui.notify("Goal unchanged.");
      return;
    }
  }

  const result = replaceGoal(trimmed);
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
