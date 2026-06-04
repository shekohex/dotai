import { formatDurationHuman } from "../extensions/coreui/tools.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ChildBootstrapState, RuntimeSubagent } from "./types.js";

const DEFAULT_COMPACT_ROWS = 4;
const DEFAULT_EXPANDED_ROWS = 8;
const DEFAULT_FULLSCREEN_ROWS = 18;

export type SubagentDashboardRenderMode = "compact" | "expanded";

export type SubagentDashboardRenderOptions = {
  title?: string;
  mode?: SubagentDashboardRenderMode;
  maxRows?: number;
  hints?: string[];
};

export type SubagentTerminalRetentionOptions = {
  previous: RuntimeSubagent[];
  next: RuntimeSubagent[];
  now?: number;
  retentionMs?: number;
};

type SubagentDashboardTheme = Pick<Theme, "fg" | "bold">;

const plainDashboardTheme: SubagentDashboardTheme = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
};

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

function isTerminalStatus(status: RuntimeSubagent["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function getStatusTone(status: RuntimeSubagent["status"]): "success" | "warning" | "error" | "dim" {
  if (status === "completed") {
    return "success";
  }
  if (status === "failed" || status === "cancelled") {
    return "error";
  }
  if (status === "running") {
    return "warning";
  }
  return "dim";
}

function renderTitleLine(
  subagents: RuntimeSubagent[],
  width: number,
  theme: SubagentDashboardTheme,
  title: string,
  hints: string[],
): string {
  const runningCount = subagents.filter((subagent) => subagent.status === "running").length;
  const idleCount = subagents.filter((subagent) => subagent.status === "idle").length;
  const terminalCount = subagents.filter((subagent) => isTerminalStatus(subagent.status)).length;
  const parts = [
    theme.fg("accent", theme.bold(title)),
    `${subagents.length} active`,
    runningCount > 0 ? `${runningCount} running` : undefined,
    idleCount > 0 ? `${idleCount} idle` : undefined,
    terminalCount > 0 ? `${terminalCount} done` : undefined,
  ].filter((part): part is string => part !== undefined);
  const summary = parts.join(theme.fg("dim", " · "));
  const hintText = hints.length > 0 ? theme.fg("dim", ` ${hints.join(" · ")}`) : "";
  const hintWidth = visibleWidth(hintText);
  const availableSummaryWidth = Math.max(1, width - hintWidth);

  if (hintText.length > 0 && width >= 74) {
    return truncateToWidth(summary, availableSummaryWidth, "…") + hintText;
  }

  return truncateToWidth(summary, width, "…");
}

function formatSubagentHints(subagent: RuntimeSubagent): string[] {
  const hints: string[] = [];
  if (subagent.handoff) {
    hints.push("handoff");
  }
  if (subagent.completion !== undefined && subagent.completion !== false) {
    hints.push(subagent.completion.deliverAs ?? "steer");
  }
  if (subagent.paneId !== undefined && subagent.paneId.length > 0) {
    hints.push(subagent.paneId);
  }
  return hints;
}

function formatSubagentSummary(subagent: RuntimeSubagent): string | undefined {
  const summary = subagent.structuredError?.message ?? subagent.summary;
  if (summary === undefined || summary.trim().length === 0) {
    return undefined;
  }
  return summarizeTask(summary, 96);
}

function renderSubagentRow(
  subagent: RuntimeSubagent,
  width: number,
  theme: SubagentDashboardTheme,
  mode: SubagentDashboardRenderMode,
): string[] {
  const status = theme.fg(getStatusTone(subagent.status), subagent.status);
  const activity =
    formatActivity(subagent) ?? summarizeTask(subagent.task, mode === "compact" ? 36 : 60);
  const hints = formatSubagentHints(subagent);
  const countdown = formatAutoExitCountdown(subagent);
  const meta = [
    subagent.modeLabel || subagent.mode,
    formatElapsed(subagent),
    ...hints,
    countdown,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  const name = theme.fg("text", subagent.name);
  const firstLine = `  ${name} ${theme.fg("dim", "·")} ${status} ${theme.fg("dim", "·")} ${theme.fg("muted", meta.join(" · "))}`;

  if (mode === "compact") {
    return [truncateToWidth(`${firstLine} ${theme.fg("dim", "·")} ${activity}`, width, "…")];
  }

  const summary = formatSubagentSummary(subagent);
  if (summary !== undefined && isTerminalStatus(subagent.status)) {
    return [
      truncateToWidth(firstLine, width, "…"),
      truncateToWidth(`    ${activity}`, width, "…"),
      truncateToWidth(`    ${summary}`, width, "…"),
    ];
  }
  return [truncateToWidth(firstLine, width, "…"), truncateToWidth(`    ${activity}`, width, "…")];
}

function sortSubagentsForDisplay(subagents: RuntimeSubagent[]): RuntimeSubagent[] {
  return subagents.slice().toSorted((left, right) => {
    const leftTerminal = isTerminalStatus(left.status) ? 1 : 0;
    const rightTerminal = isTerminalStatus(right.status) ? 1 : 0;
    if (leftTerminal !== rightTerminal) {
      return leftTerminal - rightTerminal;
    }
    return left.startedAt - right.startedAt;
  });
}

export function renderSubagentOverviewWidget(subagents: RuntimeSubagent[]): string[] | undefined {
  return renderSubagentDashboardLines(subagents, 120, undefined, { mode: "compact" });
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

export function renderSubagentDashboardLines(
  subagents: RuntimeSubagent[],
  width: number,
  theme?: SubagentDashboardTheme,
  options: SubagentDashboardRenderOptions = {},
): string[] | undefined {
  const activeSubagents = countActiveSubagents(subagents);
  if (activeSubagents.length === 0) {
    return undefined;
  }

  const safeWidth = Math.max(1, width);
  const renderTheme = theme ?? plainDashboardTheme;
  const mode = options.mode ?? "compact";
  const maxRows =
    options.maxRows ?? (mode === "compact" ? DEFAULT_COMPACT_ROWS : DEFAULT_EXPANDED_ROWS);
  const title = options.title ?? "Subagents";
  const hints =
    options.hints ??
    (mode === "compact"
      ? ["/subagents toggle", "ctrl+alt+u"]
      : ["/subagents toggle", "/subagents fullscreen"]);
  const titleLine = renderTitleLine(activeSubagents, safeWidth, renderTheme, title, hints);
  const rows = sortSubagentsForDisplay(activeSubagents).flatMap((subagent) =>
    renderSubagentRow(subagent, safeWidth, renderTheme, mode),
  );
  const rowLimit = Math.max(0, maxRows - 1);
  if (rowLimit === 0) {
    return [titleLine];
  }
  if (rows.length <= rowLimit) {
    return [titleLine, ...rows];
  }

  const visibleRowLimit = Math.max(0, rowLimit - 1);
  const hiddenRows = rows.length - visibleRowLimit;
  return [
    titleLine,
    ...rows.slice(0, visibleRowLimit),
    truncateToWidth(`  +${hiddenRows} more rows`, safeWidth, "…"),
  ];
}

export function createSubagentDashboardWidget(input: {
  subagents: RuntimeSubagent[];
  title?: string;
  mode?: SubagentDashboardRenderMode;
  maxRows?: number;
}): (tui: TUI, theme: Theme) => Component {
  return (_tui, theme) => ({
    render(width: number): string[] {
      return (
        renderSubagentDashboardLines(input.subagents, width, theme, {
          title: input.title,
          mode: input.mode,
          maxRows: input.maxRows,
        }) ?? []
      );
    },
    invalidate(): void {},
  });
}

export function createSubagentFullscreenComponent(input: {
  subagents: RuntimeSubagent[];
  title?: string;
  done: () => void;
}): (tui: TUI, theme: Theme) => Component {
  return (tui, theme) => {
    let scrollOffset = 0;
    let lastViewportRows = DEFAULT_FULLSCREEN_ROWS;
    let lastTotalRows = 0;

    return {
      render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const content =
          renderSubagentDashboardLines(input.subagents, safeWidth, theme, {
            title: input.title,
            mode: "expanded",
            maxRows: Number.MAX_SAFE_INTEGER,
            hints: [],
          }) ?? [];
        const viewportRows = DEFAULT_FULLSCREEN_ROWS;
        const maxScroll = Math.max(0, content.length - viewportRows);
        scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
        lastViewportRows = viewportRows;
        lastTotalRows = content.length;
        const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
        const scrollInfo =
          content.length > viewportRows
            ? ` ${scrollOffset + 1}-${Math.min(scrollOffset + viewportRows, content.length)}/${content.length}`
            : "";
        const helpText =
          safeWidth >= 80
            ? ` ↑↓/j/k scroll · pgup/pgdn · g/G · esc close${scrollInfo} `
            : ` j/k scroll · esc close${scrollInfo} `;
        return [
          ...visible.map((line) => truncateToWidth(line, safeWidth, "…")),
          ...Array.from({ length: Math.max(0, viewportRows - visible.length) }, () => ""),
          truncateToWidth(theme.fg("dim", helpText), safeWidth, "…", true),
        ];
      },
      handleInput(data: string): void {
        const maxScroll = Math.max(0, lastTotalRows - lastViewportRows);
        if (matchesKey(data, "escape") || data === "q") {
          input.done();
          return;
        }
        if (matchesKey(data, "up") || data === "k") {
          scrollOffset = Math.max(0, scrollOffset - 1);
        } else if (matchesKey(data, "down") || data === "j") {
          scrollOffset = Math.min(maxScroll, scrollOffset + 1);
        } else if (matchesKey(data, "pageUp") || data === "u") {
          scrollOffset = Math.max(0, scrollOffset - lastViewportRows);
        } else if (matchesKey(data, "pageDown") || data === "d") {
          scrollOffset = Math.min(maxScroll, scrollOffset + lastViewportRows);
        } else if (data === "g") {
          scrollOffset = 0;
        } else if (data === "G") {
          scrollOffset = maxScroll;
        }
        tui.requestRender();
      },
      invalidate(): void {},
    };
  };
}

export function mergeSubagentsWithTerminalRetention({
  previous,
  next,
  now = Date.now(),
  retentionMs = 15_000,
}: SubagentTerminalRetentionOptions): RuntimeSubagent[] {
  const nextIds = new Set(next.map((subagent) => subagent.sessionId));
  const retained = previous.filter((subagent) => {
    if (!isTerminalStatus(subagent.status) || nextIds.has(subagent.sessionId)) {
      return false;
    }
    const completedAt = subagent.completedAt ?? subagent.updatedAt;
    return now - completedAt <= retentionMs;
  });
  return [...next, ...retained]
    .filter(
      (subagent, index, all) =>
        all.findIndex((candidate) => candidate.sessionId === subagent.sessionId) === index,
    )
    .toSorted((left, right) => left.startedAt - right.startedAt);
}
