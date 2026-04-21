import type { Theme } from "@mariozechner/pi-coding-agent";
import type {
  RuntimeSubagent,
  SubagentToolParams,
  SubagentToolResultDetails,
} from "../../subagent-sdk/types.js";
import {
  formatScalarValue,
  getStartGuidanceText,
  shortSessionId,
  summarizeTask,
  summarizeWhitespace,
} from "./shared.js";

function formatCollapsedCallText(args: SubagentToolParams, theme: Theme): string {
  const prefix = theme.fg("toolTitle", theme.bold("π"));
  const separator = theme.fg("dim", " · ");
  const action = theme.fg("accent", args.action);

  if (args.action === "start") {
    return `${prefix} ${action}${separator}${theme.fg("muted", `${args.name ?? "..."} · ${args.mode ?? "worker"} · ${summarizeTask(args.task)}`)}`;
  }
  if (args.action === "message") {
    return `${prefix} ${action}${separator}${theme.fg("muted", `${shortSessionId(args.sessionId)} · ${args.delivery ?? "steer"} · ${summarizeTask(args.message, 40)}`)}`;
  }
  if (args.action === "cancel") {
    return `${prefix} ${action}${separator}${theme.fg("muted", shortSessionId(args.sessionId))}`;
  }

  return `${prefix} ${action}`;
}

function formatTimestamp(value: number | undefined): string {
  return typeof value === "number" ? new Date(value).toISOString() : "-";
}

function formatField(
  label: string,
  value: string | number | boolean | undefined,
  multiline = false,
): string[] {
  const text = formatScalarValue(value);
  if (!multiline && !text.includes("\n")) {
    return [`${label}: ${text}`];
  }

  return [`${label}:`, ...text.split("\n").map((line) => `  ${line}`)];
}

function formatExpandedCallText(args: SubagentToolParams, theme: Theme): string {
  const lines = [`${theme.fg("toolTitle", theme.bold("π"))} ${theme.fg("accent", args.action)}`];

  if (args.action === "start") {
    lines.push(...formatField("name", args.name));
    lines.push(...formatField("mode", args.mode ?? "worker"));
    lines.push(...formatField("cwd", args.cwd));
    lines.push(...formatField("handoff", Boolean(args.handoff)));
    lines.push(...formatField("autoExit", args.autoExit));
    lines.push(...formatField("task", args.task, true));
    return lines.join("\n");
  }

  if (args.action === "message") {
    lines.push(...formatField("sessionId", args.sessionId));
    lines.push(...formatField("delivery", args.delivery ?? "steer"));
    lines.push(...formatField("message", args.message, true));
    return lines.join("\n");
  }

  if (args.action === "cancel") {
    lines.push(...formatField("sessionId", args.sessionId));
    return lines.join("\n");
  }

  return lines.join("\n");
}

function formatSubagentStateDetails(state: RuntimeSubagent): string {
  return [
    ...formatField("event", state.event),
    ...formatField("name", state.name),
    ...formatField("status", state.status),
    ...formatField("sessionId", state.sessionId),
    ...formatField("paneId", state.paneId || "-"),
    ...formatField("parentSessionId", state.parentSessionId),
    ...formatField("parentSessionPath", state.parentSessionPath),
    ...formatField("mode", state.modeLabel),
    ...formatField("cwd", state.cwd),
    ...formatField("sessionPath", state.sessionPath),
    ...formatField("handoff", state.handoff),
    ...formatField("autoExit", state.autoExit),
    ...formatField("autoExitTimeoutMs", state.autoExitTimeoutMs),
    ...formatField("autoExitTimeoutActive", state.autoExitTimeoutActive),
    ...formatField("autoExitDeadlineAt", formatTimestamp(state.autoExitDeadlineAt)),
    ...formatField("task", state.task, true),
    ...formatField("summary", state.summary, true),
    ...formatField(
      "structured",
      state.structured === undefined ? undefined : JSON.stringify(state.structured, null, 2),
      true,
    ),
    ...formatField(
      "outputFormat",
      state.outputFormat ? JSON.stringify(state.outputFormat, null, 2) : undefined,
      true,
    ),
    ...formatField(
      "structuredError",
      state.structuredError ? JSON.stringify(state.structuredError, null, 2) : undefined,
      true,
    ),
    ...formatField("exitCode", state.exitCode),
    ...formatField("startedAt", formatTimestamp(state.startedAt)),
    ...formatField("updatedAt", formatTimestamp(state.updatedAt)),
    ...formatField("completedAt", formatTimestamp(state.completedAt)),
  ].join("\n");
}

function formatListDetails(subagents: RuntimeSubagent[]): string {
  if (subagents.length === 0) {
    return "count: 0\nsubagents: -";
  }

  return [
    `count: ${subagents.length}`,
    ...subagents.flatMap((subagent, index) => [
      "",
      `subagent ${index + 1}:`,
      ...formatSubagentStateDetails(subagent)
        .split("\n")
        .map((line) => `  ${line}`),
    ]),
  ].join("\n");
}

function formatExpandedResult(details: SubagentToolResultDetails | undefined): string {
  if (!details) {
    return "status: ok";
  }
  if (details.action === "list") {
    return formatListDetails(details.subagents);
  }

  const resultLines = [formatSubagentStateDetails(details.state)];
  if (details.action === "start") {
    resultLines.push(...formatField("prompt", details.prompt, true));
    resultLines.push(...formatField("promptGuidance", getStartGuidanceText(), true));
    if (details.structured !== undefined) {
      resultLines.push(
        ...formatField("structured", JSON.stringify(details.structured, null, 2), true),
      );
    }
    return resultLines.join("\n");
  }
  if (details.action === "message") {
    if (details.autoResumed === true) {
      resultLines.push(...formatField("autoResumed", details.autoResumed));
      resultLines.push(...formatField("resumePrompt", details.resumePrompt, true));
    }
    resultLines.push(...formatField("delivery", details.delivery));
    resultLines.push(...formatField("message", details.message, true));
  }
  return resultLines.join("\n");
}

function countSubagentsByStatus(
  subagents: RuntimeSubagent[],
): Map<RuntimeSubagent["status"], number> {
  const counts = new Map<RuntimeSubagent["status"], number>();
  for (const subagent of subagents) {
    counts.set(subagent.status, (counts.get(subagent.status) ?? 0) + 1);
  }
  return counts;
}

function formatListCollapsedSummary(subagents: RuntimeSubagent[], theme: Theme): string {
  const counts = countSubagentsByStatus(subagents);
  const segments = [
    theme.fg("success", `${subagents.length} agent${subagents.length === 1 ? "" : "s"}`),
  ];
  const orderedStatuses: Array<RuntimeSubagent["status"]> = [
    "running",
    "idle",
    "completed",
    "cancelled",
    "failed",
  ];

  for (const status of orderedStatuses) {
    const count = counts.get(status) ?? 0;
    if (count === 0) {
      continue;
    }
    segments.push(theme.fg("muted", `${count} ${status}`));
  }
  return segments.join(theme.fg("dim", " · "));
}

function formatStateCollapsedSummary(state: RuntimeSubagent, theme: Theme): string {
  return [theme.fg("success", state.name), theme.fg("muted", state.status)].join(
    theme.fg("dim", " · "),
  );
}

function formatMessageCollapsedSummary(
  details: Extract<SubagentToolResultDetails, { action: "message" }>,
  theme: Theme,
): string {
  return [
    theme.fg("success", details.state.name),
    theme.fg("muted", details.state.status),
    ...(details.autoResumed === true ? [theme.fg("muted", "resumed")] : []),
    theme.fg("muted", details.delivery),
    theme.fg("muted", summarizeWhitespace(details.message, 36)),
  ].join(theme.fg("dim", " · "));
}

function formatCollapsedResultSummary(
  details: SubagentToolResultDetails | undefined,
  theme: Theme,
): string {
  if (details?.action === "list") {
    return formatListCollapsedSummary(details.subagents, theme);
  }
  if (details?.action === "message") {
    return formatMessageCollapsedSummary(details, theme);
  }
  if (details === undefined) {
    return theme.fg("success", "ok");
  }
  return formatStateCollapsedSummary(details.state, theme);
}

export {
  formatCollapsedCallText,
  formatCollapsedResultSummary,
  formatExpandedCallText,
  formatExpandedResult,
};
