import { formatDurationHuman } from "../extensions/coreui/tools.js";
import type { ChildBootstrapState, RuntimeSubagent } from "./types.js";

function summarizeTask(task: string, maxLength = 72): string {
  const normalized = task.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatAutoExitCountdown(subagent: RuntimeSubagent): string | undefined {
  if (!subagent.autoExit || subagent.autoExitTimeoutActive !== true || subagent.status !== "idle") {
    return undefined;
  }

  if (subagent.autoExitDeadlineAt === undefined) {
    return undefined;
  }

  const remainingMs = Math.max(0, subagent.autoExitDeadlineAt - Date.now());
  return `auto-exit ${formatDurationHuman(remainingMs)}`;
}

function countActiveSubagents(subagents: RuntimeSubagent[]): RuntimeSubagent[] {
  return subagents.filter(
    (subagent) =>
      subagent.status === "running" ||
      subagent.status === "idle" ||
      subagent.status === "completed" ||
      subagent.status === "failed" ||
      subagent.status === "cancelled",
  );
}

function formatActivity(subagent: RuntimeSubagent): string | undefined {
  if (!subagent.activity) {
    return undefined;
  }

  const detail = subagent.activity.detail?.trim();
  if (detail === undefined || detail.length === 0) {
    return subagent.activity.label;
  }

  return `${subagent.activity.label}: ${summarizeTask(detail, 40)}`;
}

function formatElapsed(subagent: RuntimeSubagent): string {
  const endTime = subagent.completedAt ?? Date.now();
  return formatDurationHuman(Math.max(0, endTime - subagent.startedAt));
}

function summarizeActiveSubagentNames(subagents: RuntimeSubagent[]): string | undefined {
  if (subagents.length === 0) {
    return undefined;
  }

  const names = subagents.map((subagent) => subagent.name);
  if (names.length <= 3) {
    return names.join(", ");
  }

  return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

export function renderSubagentOverviewWidget(subagents: RuntimeSubagent[]): string[] | undefined {
  const activeSubagents = countActiveSubagents(subagents);
  if (activeSubagents.length === 0) {
    return undefined;
  }

  const runningCount = activeSubagents.filter((subagent) => subagent.status === "running").length;
  const idleCount = activeSubagents.filter((subagent) => subagent.status === "idle").length;
  const doneCount = activeSubagents.filter((subagent) => subagent.activity?.done === true).length;
  const parts = [`Subagents active: ${activeSubagents.length}`];

  if (runningCount > 0) {
    parts.push(`${runningCount} running`);
  }
  if (idleCount > 0) {
    parts.push(`${idleCount} idle`);
  }
  if (doneCount > 0) {
    parts.push(`${doneCount} done`);
  }

  const namesSummary = summarizeActiveSubagentNames(activeSubagents);
  if (namesSummary !== undefined) {
    parts.push(namesSummary);
  }

  return [parts.join(" · ")];
}

export function renderChildSessionWidget(childState: ChildBootstrapState): string[] {
  const parts = ["Subagent session", childState.name];
  if (childState.mode !== undefined && childState.mode.length > 0) {
    parts.push(childState.mode);
  }
  return [parts.join(" · ")];
}

export function renderSubagentWidget(subagents: RuntimeSubagent[]): string[] | undefined {
  if (subagents.length === 0) {
    return undefined;
  }

  return [
    `Subagents (${subagents.length})`,
    ...subagents
      .slice()
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((subagent) => {
        const countdown = formatAutoExitCountdown(subagent);
        const parts = [
          subagent.name,
          subagent.status,
          formatElapsed(subagent),
          formatActivity(subagent) ?? summarizeTask(subagent.task, 48),
        ];

        if (countdown !== undefined && countdown.length > 0) {
          parts.push(countdown);
        }

        return parts.join(" · ");
      }),
  ];
}
