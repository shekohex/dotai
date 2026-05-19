import type { GoalStatus, ThreadGoal } from "./types.js";

const COMPACT_TOKEN_UNITS = [
  { suffix: "T", value: 1_000_000_000_000 },
  { suffix: "B", value: 1_000_000_000 },
  { suffix: "M", value: 1_000_000 },
  { suffix: "K", value: 1_000 },
] as const;

export interface GoalToolRecord {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalToolResponse {
  goal: GoalToolRecord | null;
  completionUsageReport: string | null;
}

export function formatDuration(seconds: number): string {
  const normalized = Math.max(0, Math.trunc(seconds));
  const days = Math.floor(normalized / 86_400);
  const hours = Math.floor((normalized % 86_400) / 3_600);
  const minutes = Math.floor((normalized % 3_600) / 60);
  const remainingSeconds = normalized % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours}h ${minutes}m`;
    }

    return `${hours}h`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return `${remainingSeconds}s`;
}

export function formatInteger(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString("en-US");
}

export function formatCompactTokenValue(value: number): string {
  const normalized = Math.max(0, Math.trunc(value));
  if (normalized < 100_000) {
    return formatInteger(normalized);
  }

  const unit = COMPACT_TOKEN_UNITS.find((candidate) => normalized >= candidate.value);
  if (!unit) {
    return formatInteger(normalized);
  }

  const scaled = normalized / unit.value;
  let fractionDigits = 0;
  if (scaled < 10) {
    fractionDigits = 2;
  } else if (scaled < 100) {
    fractionDigits = 1;
  }

  const compact = scaled.toLocaleString("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  });
  return `${compact}${unit.suffix}`;
}

export function formatTokenValue(value: number): string {
  const exact = formatInteger(value);
  const compact = formatCompactTokenValue(value);
  if (compact === exact) {
    return exact;
  }

  return `${compact} (${exact})`;
}

function statusLabel(status: GoalStatus): string {
  return status === "budgetLimited" ? "paused" : status;
}

function commandHint(status: GoalStatus): string {
  if (status === "active") {
    return "/goal pause, /goal clear";
  }

  if (status === "paused") {
    return "/goal resume, /goal clear";
  }

  return "/goal clear";
}

export function formatGoalSummary(goal: ThreadGoal | null): string {
  if (!goal) {
    return ["Usage: /goal <objective>", "No goal is currently set."].join("\n");
  }

  const lines = [
    `Status: ${statusLabel(goal.status)}`,
    `Objective: ${goal.objective}`,
    `Time used: ${formatDuration(goal.usage.activeSeconds)}`,
    `Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}`,
    `Hint: ${commandHint(goal.status)}`,
  ];

  return lines.join("\n");
}

export function formatFooterStatus(goal: ThreadGoal | null): string | undefined {
  if (!goal) {
    return undefined;
  }

  if (goal.status === "active") {
    if (goal.usage.activeSeconds > 0) {
      return `Pursuing goal (${formatDuration(goal.usage.activeSeconds)})`;
    }

    return "Pursuing goal";
  }

  if (goal.status === "paused") {
    return "Goal paused (/goal resume)";
  }

  if (goal.status === "budgetLimited") {
    return "Goal paused (/goal resume)";
  }

  if (goal.usage.activeSeconds > 0) {
    return `Goal achieved (${formatDuration(goal.usage.activeSeconds)})`;
  }

  return "Goal achieved";
}

export function toToolGoal(goal: ThreadGoal): GoalToolRecord {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.usage.tokensUsed,
    timeUsedSeconds: goal.usage.activeSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export function completionUsageReport(goal: ThreadGoal | null): string | null {
  if (!goal || goal.status !== "complete") {
    return null;
  }

  if (goal.usage.tokensUsed <= 0 && goal.usage.activeSeconds <= 0) {
    return null;
  }

  const parts: string[] = [];
  if (goal.usage.activeSeconds > 0) {
    parts.push(`time used: ${formatDuration(goal.usage.activeSeconds)}.`);
  }

  if (goal.usage.tokensUsed > 0) {
    parts.push(`tokens used: ${formatInteger(goal.usage.tokensUsed)}.`);
  }

  return `Goal achieved. Report final usage to the user: ${parts.join(" ")}`;
}

export function goalToolResponse(
  goal: ThreadGoal | null,
  includeCompletionUsageReport = false,
): GoalToolResponse {
  return {
    goal: goal ? toToolGoal(goal) : null,
    completionUsageReport: includeCompletionUsageReport ? completionUsageReport(goal) : null,
  };
}

export function toToolText(goal: ThreadGoal | null, includeCompletionUsageReport = false): string {
  return JSON.stringify(goalToolResponse(goal, includeCompletionUsageReport), null, 2);
}
