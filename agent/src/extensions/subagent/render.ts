import type { RuntimeSubagent } from "./types.js";

function summarizeTask(task: string, maxLength = 72): string {
  const normalized = task.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
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
      .map((subagent) => `${subagent.name} · ${subagent.status} · ${subagent.modeLabel} · ${subagent.sessionId.slice(0, 8)} · ${summarizeTask(subagent.task, 48)}`),
  ];
}
