import { formatDurationHuman } from "../coreui/tools.js";
import type { RuntimeSubagent } from "./types.js";

function summarizeTask(task: string, maxLength = 72): string {
  const normalized = task.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatAutoExitCountdown(subagent: RuntimeSubagent): string | undefined {
  if (!subagent.autoExit || !subagent.autoExitTimeoutActive || subagent.status !== "idle") {
    return undefined;
  }

  if (subagent.autoExitDeadlineAt === undefined) {
    return undefined;
  }

  const remainingMs = Math.max(0, subagent.autoExitDeadlineAt - Date.now());
  return `auto-exit ${formatDurationHuman(remainingMs)}`;
}

export function renderSubagentWidget(subagents: RuntimeSubagent[]): string[] | undefined {
  if (subagents.length === 0) {
    return undefined;
  }

  return [
    `Subagents (${subagents.length})`,
    ...subagents
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((subagent) => {
        const countdown = formatAutoExitCountdown(subagent);
        const parts = [subagent.name, subagent.status, subagent.modeLabel, subagent.sessionId.slice(0, 8), summarizeTask(subagent.task, 48)];

        if (countdown) {
          parts.push(countdown);
        }

        return parts.join(" · ");
      }),
  ];
}
