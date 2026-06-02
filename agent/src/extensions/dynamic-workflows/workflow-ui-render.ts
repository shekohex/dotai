import type { ThemeLike } from "./workflow-ui.js";
import type {
  WorkflowAgentActivityEvent,
  WorkflowAgentSnapshot,
  WorkflowSnapshot,
} from "./display.js";

export function progressBar(done: number, total: number, width: number): string {
  const size = Math.max(6, Math.min(24, width));
  const filled = total <= 0 ? 0 : Math.round((done / total) * size);
  return `${"█".repeat(filled)}${"░".repeat(size - filled)}`;
}

export function spinnerFrame(timestamp = Date.now()): string {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  return frames[Math.floor(timestamp / 120) % frames.length] ?? "⠋";
}

export function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return width <= 1 ? value.slice(0, width) : `${value.slice(0, Math.max(0, width - 1))}…`;
}

export function statusColor(status: string): string {
  if (status === "running") return "accent";
  if (status === "completed" || status === "done") return "success";
  if (status === "failed" || status === "error") return "error";
  if (status === "paused") return "warning";
  return "muted";
}

export function renderMetricLine(
  theme: ThemeLike,
  label: string,
  value: string,
  detail = "",
): string {
  const suffix = detail === "" ? "" : theme.fg("dim", `  ${detail}`);
  return `${theme.fg("muted", label.padEnd(12))} ${theme.bold(value)}${suffix}`;
}

export function renderRunEventFeed(
  snapshot: WorkflowSnapshot,
  theme: ThemeLike,
  limit = 10,
): string[] {
  const events: string[] = [];
  for (const phase of snapshot.phases) {
    events.push(`${theme.fg("dim", "◇")} ${theme.fg("dim", "phase")} ${phase}`);
  }
  if (snapshot.currentPhase !== undefined && snapshot.currentPhase !== "") {
    events.push(
      `${theme.fg("accent", "◆")} ${theme.fg("accent", "phase")} ${snapshot.currentPhase}`,
    );
  }
  for (const log of snapshot.logs) {
    events.push(`${theme.fg("muted", "•")} ${theme.fg("dim", "log")} ${log}`);
  }
  for (const agent of snapshot.agents) {
    const phase = agent.phase === undefined ? "" : ` · ${agent.phase}`;
    const result =
      agent.resultPreview === undefined ? "" : ` · ${truncate(agent.resultPreview, 48)}`;
    for (const activity of agent.activityEvents ?? []) {
      const detail = activity.detail === undefined ? "" : ` · ${truncate(activity.detail, 48)}`;
      events.push(
        `${renderActivityEventInline(activity, theme)} ${theme.fg("dim", `#${agent.id}`)}${theme.fg("dim", detail)}`,
      );
    }
    events.push(
      `${renderStatusInline(agent.status, theme)} ${theme.fg("dim", `#${agent.id}`)} ${agent.label}${theme.fg("dim", phase + result)}`,
    );
  }
  return events.slice(-limit);
}

export function renderStatusInline(status: string, theme: ThemeLike): string {
  let icon = "•";
  if (status === "running") icon = spinnerFrame();
  else if (status === "done" || status === "completed") icon = "✓";
  else if (status === "error" || status === "failed") icon = "✗";
  else if (status === "paused") icon = "⏸";
  const color = statusColor(status);
  return `${theme.fg(color, icon)} ${theme.fg(color, status)}`;
}

export function renderActivityEventInline(
  event: WorkflowAgentActivityEvent,
  theme: ThemeLike,
): string {
  if (event.kind === "thinking") {
    const text = theme.italic?.(event.label) ?? event.label;
    return `${theme.fg("dim", "◌")} ${theme.fg("dim", text)}`;
  }
  if (event.kind.startsWith("tool")) {
    const marker = event.done === true ? theme.fg("success", "✓") : theme.fg("warning", "◆");
    const label =
      event.done === true ? theme.fg("success", event.label) : theme.fg("accent", event.label);
    return `${marker} ${label}`;
  }
  const marker = event.done === true ? theme.fg("success", "✓") : theme.fg("muted", "•");
  return `${marker} ${event.label}`;
}

export function renderRunOverview(input: {
  runId: string;
  name: string;
  status: string;
  snapshot: WorkflowSnapshot;
  width: number;
  theme: ThemeLike;
}): string[] {
  const total = input.snapshot.agentCount;
  const done = input.snapshot.doneCount;
  const tokens = input.snapshot.tokenUsage?.total ?? 0;
  const bar = progressBar(done, total, Math.max(8, Math.min(24, input.width - 40)));
  const lines = [
    input.theme.fg("accent", input.theme.bold("Run overview")),
    renderMetricLine(input.theme, "workflow", input.name, input.runId),
    renderMetricLine(input.theme, "status", input.status, input.snapshot.currentPhase ?? ""),
    renderMetricLine(input.theme, "agents", `${done}/${total}`, bar),
    renderMetricLine(input.theme, "running", String(input.snapshot.runningCount)),
    renderMetricLine(input.theme, "errors", String(input.snapshot.errorCount)),
  ];
  if (tokens > 0) lines.push(renderMetricLine(input.theme, "tokens", tokens.toLocaleString()));
  if (input.snapshot.description !== undefined && input.snapshot.description !== "") {
    lines.push(
      renderMetricLine(
        input.theme,
        "description",
        truncate(input.snapshot.description, input.width - 16),
      ),
    );
  }
  return lines;
}

export function renderEventsSection(
  snapshot: WorkflowSnapshot | undefined,
  theme: ThemeLike,
): string[] {
  if (snapshot === undefined) return [];
  const events = renderRunEventFeed(snapshot, theme);
  const lines = ["", theme.fg("accent", theme.bold("Recent events"))];
  if (events.length === 0) {
    lines.push(theme.fg("dim", "No workflow events yet."));
    return lines;
  }
  lines.push(...events);
  return lines;
}

export function renderAgentActivityLines(agent: WorkflowAgentSnapshot, theme: ThemeLike): string[] {
  const events = agent.activityEvents ?? [];
  if (events.length === 0) return [theme.fg("dim", "No live activity captured yet.")];
  return events.slice(-16).map((event) => {
    const detail = event.detail === undefined ? "" : theme.fg("dim", `  ${event.detail}`);
    return `${renderActivityEventInline(event, theme)}${detail}`;
  });
}
