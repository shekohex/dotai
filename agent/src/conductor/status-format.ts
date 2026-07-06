import { Value } from "typebox/value";

import { RunRecordSchema, type RunRecord } from "./store/types.js";

export function formatRunsTable(runs: RunRecord[]): string {
  if (runs.length === 0) return "No conductor runs.";
  const rows = runs.map((run) => {
    const validated = Value.Parse(RunRecordSchema, run);
    return {
      run: validated.runId,
      issue: `${validated.owner}/${validated.repo}#${validated.issueNumber}`,
      status: validated.paused ? `${validated.status} paused` : validated.status,
      attempt: String(validated.attempt),
      branch: validated.branch,
      pr: validated.prUrl ?? "-",
      worktree: validated.worktreePath,
      herdr: validated.herdr.paneId ?? validated.herdr.tabId ?? "-",
      error: validated.lastError ?? "-",
    };
  });
  return table([
    ["Run", "Issue", "Status", "Try", "Branch", "PR", "Worktree", "Herdr", "Error"],
    ...rows.map((row) => [
      row.run,
      row.issue,
      row.status,
      row.attempt,
      row.branch,
      row.pr,
      row.worktree,
      row.herdr,
      row.error,
    ]),
  ]);
}

export function formatRunsJson(runs: RunRecord[]): string {
  return `${JSON.stringify(
    runs.map((run) => Value.Parse(RunRecordSchema, run)),
    null,
    2,
  )}\n`;
}

function table(rows: string[][]): string {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
