import { formatDurationHuman } from "../extensions/coreui/tools.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { isTerminalSubagentStatus } from "./status.js";
import type { ChildBootstrapState, RuntimeSubagent } from "./types.js";

const DEFAULT_COMPACT_ROWS = 4;
const DEFAULT_EXPANDED_ROWS = 4;
const DEFAULT_EXPANDED_LINE_BUDGET = 12;

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
type SubagentColumnWidths = {
  name: number;
  mode: number;
  elapsed: number;
  pane: number;
  status: number;
  description: number;
};
type SubagentStatusCounts = {
  running: number;
  idle: number;
  completed: number;
  failed: number;
  cancelled: number;
};

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

function formatMode(subagent: RuntimeSubagent): string {
  return subagent.modeLabel ?? subagent.mode ?? "worker";
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

function countSubagentStatuses(subagents: RuntimeSubagent[]): SubagentStatusCounts {
  return {
    running: subagents.filter((subagent) => subagent.status === "running").length,
    idle: subagents.filter((subagent) => subagent.status === "idle").length,
    completed: subagents.filter((subagent) => subagent.status === "completed").length,
    failed: subagents.filter((subagent) => subagent.status === "failed").length,
    cancelled: subagents.filter((subagent) => subagent.status === "cancelled").length,
  };
}

function truncateDisplayText(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  return truncateToWidth(text, width, "…", true);
}

function renderFramedTitleLine(
  title: string,
  width: number,
  theme: SubagentDashboardTheme,
  hints: string[],
): string {
  const hintCandidates = hints.filter((hint) => hint.trim().length > 0);
  for (const candidate of hintCandidates) {
    const hint = theme.fg("dim", ` ${candidate}`);
    const hintWidth = visibleWidth(hint);
    if (hintWidth > width) {
      continue;
    }
    const availableLeftWidth = Math.max(0, width - hintWidth);
    const titleText = truncateDisplayText(
      `🤖 ${title.toLowerCase()}`,
      Math.max(0, availableLeftWidth - 5),
    );
    const titlePrefix = theme.fg("borderMuted", "───") + theme.fg("accent", ` ${titleText} `);
    const titlePrefixWidth = visibleWidth(titlePrefix);
    const left =
      titlePrefix +
      theme.fg("borderMuted", "─".repeat(Math.max(0, availableLeftWidth - titlePrefixWidth)));
    return appendRightAlignedAdaptiveHint(left, width, theme, [candidate]);
  }
  const titleText = truncateDisplayText(`🤖 ${title.toLowerCase()}`, Math.max(0, width - 5));
  const titlePrefix = theme.fg("borderMuted", "───") + theme.fg("accent", ` ${titleText} `);
  const titlePrefixWidth = visibleWidth(titlePrefix);
  return truncateToWidth(
    titlePrefix + theme.fg("borderMuted", "─".repeat(Math.max(0, width - titlePrefixWidth))),
    width,
    "…",
    true,
  );
}

function getExpandedDashboardHintVariants(): string[] {
  return [
    "ctrl+alt+u collapse • /subagents fullscreen",
    "ctrl+alt+u collapse • fullscreen",
    "ctrl+alt+u collapse",
  ];
}

function appendRightAlignedAdaptiveHint(
  left: string,
  width: number,
  theme: SubagentDashboardTheme,
  candidates: string[],
): string {
  if (width <= 0) {
    return "";
  }
  const leftWidth = visibleWidth(left);
  for (const candidate of candidates) {
    const hint = theme.fg("dim", ` ${candidate}`);
    const hintWidth = visibleWidth(hint);
    if (hintWidth > width) {
      continue;
    }
    if (leftWidth + hintWidth <= width) {
      return left + " ".repeat(Math.max(0, width - leftWidth - hintWidth)) + hint;
    }
    const availableLeftWidth = Math.max(0, width - hintWidth);
    const truncatedLeft = truncateToWidth(left, availableLeftWidth, "…", true);
    const truncatedLeftWidth = visibleWidth(truncatedLeft);
    return truncatedLeft + " ".repeat(Math.max(0, width - truncatedLeftWidth - hintWidth)) + hint;
  }
  return truncateToWidth(left, width, "…", true);
}

function renderTitleLine(
  subagents: RuntimeSubagent[],
  width: number,
  theme: SubagentDashboardTheme,
  title: string,
  hints: string[],
): string {
  const counts = countSubagentStatuses(subagents);
  const parts = [
    theme.fg("accent", theme.bold(title)),
    `${subagents.length} active`,
    counts.running > 0 ? `${counts.running} running` : undefined,
    counts.idle > 0 ? `${counts.idle} idle` : undefined,
    counts.completed > 0 ? `${counts.completed} done` : undefined,
    counts.failed > 0 ? `${counts.failed} failed` : undefined,
    counts.cancelled > 0 ? `${counts.cancelled} cancelled` : undefined,
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

function formatSubagentSummary(subagent: RuntimeSubagent): string | undefined {
  const summary = subagent.structuredError?.message ?? subagent.summary;
  if (summary === undefined || summary.trim().length === 0) {
    return undefined;
  }
  return summarizeTask(summary, 96);
}

function formatSubagentDescription(subagent: RuntimeSubagent): string {
  const summary = formatSubagentSummary(subagent);
  const activity = formatActivity(subagent) ?? summarizeTask(subagent.task, 80);
  const metadata = formatSubagentMetadata(subagent);
  const suffix = metadata.length > 0 ? ` · ${metadata.join(" · ")}` : "";
  if (summary !== undefined && isTerminalSubagentStatus(subagent.status)) {
    return `${activity} · ${summary}${suffix}`;
  }
  return `${activity}${suffix}`;
}

function formatSubagentMetadata(subagent: RuntimeSubagent): string[] {
  const metadata: string[] = [];
  if (subagent.handoff) {
    metadata.push("handoff");
  }
  if (subagent.completion !== undefined && subagent.completion !== false) {
    metadata.push(subagent.completion.deliverAs ?? "steer");
  }
  return metadata;
}

function formatActivitySummaryPart(subagent: RuntimeSubagent): string {
  return `${subagent.name} ${formatActivity(subagent) ?? subagent.status}`;
}

function wrapActivitySummary(
  parts: string[],
  width: number,
  theme: SubagentDashboardTheme,
): string[] {
  if (parts.length === 0) {
    return [];
  }
  const prefix = "Activity:";
  const indent = "         ";
  const lines: string[] = [];
  let current = "";
  let currentPrefix = prefix;

  for (const part of parts) {
    const separator = current.length > 0 ? "  " : "";
    const next = `${current}${separator}${part}`;
    const availableWidth = Math.max(1, width - 2 - currentPrefix.length - 1);
    if (current.length > 0 && visibleWidth(next) > availableWidth) {
      lines.push(
        truncateToWidth(
          `  ${theme.fg("muted", currentPrefix)} ${theme.fg("muted", current)}`,
          width,
          "…",
          true,
        ),
      );
      current = part;
      currentPrefix = indent;
    } else {
      current = next;
    }
  }

  if (current.length > 0) {
    lines.push(
      truncateToWidth(
        `  ${theme.fg("muted", currentPrefix)} ${theme.fg("muted", current)}`,
        width,
        "…",
        true,
      ),
    );
  }
  return lines;
}

function sortSubagentsForDisplay(subagents: RuntimeSubagent[]): RuntimeSubagent[] {
  return subagents.slice().toSorted((left, right) => {
    const leftTerminal = isTerminalSubagentStatus(left.status) ? 1 : 0;
    const rightTerminal = isTerminalSubagentStatus(right.status) ? 1 : 0;
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
  return renderSubagentDashboardLines(subagents, 120, undefined, { mode: "compact" });
}

function renderCompactDashboardLines(
  subagents: RuntimeSubagent[],
  width: number,
  theme: SubagentDashboardTheme,
  title: string,
  hints: string[],
  maxRows: number,
): string[] {
  const titleLine = renderTitleLine(subagents, width, theme, title, hints);
  const sortedSubagents = sortSubagentsForDisplay(subagents);
  const rowLimit = Math.max(0, maxRows - 1);
  if (rowLimit === 0) {
    return [titleLine];
  }
  const visibleSubagents = sortedSubagents.slice(0, rowLimit);
  const hiddenSubagents = sortedSubagents.length - visibleSubagents.length;
  const rows = visibleSubagents.map((subagent) =>
    truncateToWidth(formatCompactSubagentLine(subagent, theme), width, "…", true),
  );
  if (hiddenSubagents > 0 && rows.length > 0) {
    rows[rows.length - 1] = truncateToWidth(
      `  ${theme.fg("dim", `… ${hiddenSubagents + 1} hidden subagents`)}`,
      width,
      "…",
      true,
    );
  }
  return [titleLine, ...rows];
}

function formatCompactSubagentLine(
  subagent: RuntimeSubagent,
  theme: SubagentDashboardTheme,
): string {
  const meta = [
    formatMode(subagent),
    formatElapsed(subagent),
    subagent.paneId,
    ...formatSubagentMetadata(subagent),
    formatAutoExitCountdown(subagent),
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" · ");
  return `  ${theme.fg("text", subagent.name)} ${theme.fg("dim", "·")} ${theme.fg(getStatusTone(subagent.status), subagent.status)} ${theme.fg("dim", "·")} ${theme.fg("muted", meta)} ${theme.fg("dim", "·")} ${formatSubagentDescription(subagent)}`;
}

function calculateSubagentColumnWidths(
  subagents: RuntimeSubagent[],
  width: number,
): SubagentColumnWidths {
  const name = Math.max(
    12,
    Math.min(
      22,
      Math.max("name".length, ...subagents.map((subagent) => visibleWidth(subagent.name))) + 1,
    ),
  );
  const mode = Math.max(
    10,
    Math.min(
      18,
      Math.max("mode".length, ...subagents.map((subagent) => visibleWidth(formatMode(subagent)))) +
        1,
    ),
  );
  const elapsed = Math.max(
    9,
    Math.min(
      13,
      Math.max(
        "elapsed".length,
        ...subagents.map((subagent) => visibleWidth(formatElapsed(subagent))),
      ) + 1,
    ),
  );
  const pane = Math.max(
    6,
    Math.min(
      8,
      Math.max(
        "pane".length,
        ...subagents.map((subagent) => visibleWidth(subagent.paneId ?? "—")),
      ) + 1,
    ),
  );
  const status = 10;
  const fixedWidth = 2 + 3 + name + mode + elapsed + pane + status;
  return { name, mode, elapsed, pane, status, description: Math.max(12, width - fixedWidth) };
}

function renderSubagentTableHeader(
  widths: SubagentColumnWidths,
  width: number,
  theme: SubagentDashboardTheme,
): string[] {
  const header =
    `  ${theme.fg("muted", "#".padEnd(3))}` +
    theme.fg("muted", "name".padEnd(widths.name)) +
    theme.fg("muted", "mode".padEnd(widths.mode)) +
    theme.fg("muted", "elapsed".padEnd(widths.elapsed)) +
    theme.fg("muted", "pane".padEnd(widths.pane)) +
    theme.fg("muted", "status".padEnd(widths.status)) +
    theme.fg("muted", "activity / summary");
  return [
    truncateToWidth(header, width, "…", true),
    truncateToWidth(`  ${theme.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`, width),
  ];
}

function renderSubagentTableRow(
  subagent: RuntimeSubagent,
  rowNumber: number,
  widths: SubagentColumnWidths,
  width: number,
  theme: SubagentDashboardTheme,
): string {
  const row =
    `  ${theme.fg("dim", String(rowNumber).padEnd(3))}` +
    theme.fg("text", truncateToWidth(subagent.name, widths.name - 1).padEnd(widths.name)) +
    theme.fg("muted", truncateToWidth(formatMode(subagent), widths.mode - 1).padEnd(widths.mode)) +
    theme.fg(
      "muted",
      truncateToWidth(formatElapsed(subagent), widths.elapsed - 1).padEnd(widths.elapsed),
    ) +
    theme.fg(
      "muted",
      truncateToWidth(subagent.paneId ?? "—", widths.pane - 1).padEnd(widths.pane),
    ) +
    theme.fg(getStatusTone(subagent.status), subagent.status.padEnd(widths.status)) +
    theme.fg(
      "muted",
      truncateToWidth(formatSubagentDescription(subagent), widths.description, "…", true),
    );
  return truncateToWidth(row, width, "…", true);
}

function renderExpandedDashboardLines(
  subagents: RuntimeSubagent[],
  width: number,
  theme: SubagentDashboardTheme,
  title: string,
  hints: string[],
  maxRows: number,
): string[] {
  const sortedSubagents = sortSubagentsForDisplay(subagents);
  const counts = countSubagentStatuses(subagents);
  const longestSubagent = sortedSubagents.toSorted((left, right) => {
    const leftElapsed = (left.completedAt ?? Date.now()) - left.startedAt;
    const rightElapsed = (right.completedAt ?? Date.now()) - right.startedAt;
    return rightElapsed - leftElapsed;
  })[0];
  const lineBudget = Number.isFinite(maxRows)
    ? DEFAULT_EXPANDED_LINE_BUDGET
    : Number.MAX_SAFE_INTEGER;
  const lines = [
    renderFramedTitleLine(title, width, theme, hints),
    truncateToWidth(
      `  ${theme.fg("muted", "Agents:")} ${theme.fg("text", String(subagents.length))}  ${theme.fg("warning", `${counts.running} running`)}  ${theme.fg("dim", `${counts.idle} idle`)}  ${theme.fg("success", `${counts.completed} done`)}  ${theme.fg("error", `${counts.failed} failed`)}  ${theme.fg("error", `${counts.cancelled} cancelled`)}`,
      width,
      "…",
      true,
    ),
  ];

  if (longestSubagent !== undefined) {
    lines.push(
      truncateToWidth(
        `  ${theme.fg("muted", "Longest:")} ${theme.fg("warning", theme.bold(`★ ${longestSubagent.name}`))}  ${theme.fg(
          "muted",
          `${formatMode(longestSubagent)}  ${formatElapsed(longestSubagent)}  ${formatActivity(longestSubagent) ?? longestSubagent.status}`,
        )}`,
        width,
        "…",
        true,
      ),
    );
  }

  const tableBaseLines = 2;
  const requestedVisibleCount = Number.isFinite(maxRows) ? maxRows : sortedSubagents.length;
  const visibleCount = Math.max(0, Math.min(requestedVisibleCount, sortedSubagents.length));
  const hiddenSubagents = sortedSubagents.length - visibleCount;
  const hiddenLineCount = hiddenSubagents > 0 ? 1 : 0;
  const maxActivityLines = Number.isFinite(maxRows)
    ? Math.max(0, lineBudget - lines.length - 1 - tableBaseLines - hiddenLineCount - visibleCount)
    : Number.MAX_SAFE_INTEGER;

  const activityLines = wrapActivitySummary(
    sortedSubagents.slice(0, 4).map((subagent) => formatActivitySummaryPart(subagent)),
    width,
    theme,
  ).slice(0, maxActivityLines);
  lines.push(...activityLines);
  lines.push("");

  const visibleSubagents = sortedSubagents.slice(0, visibleCount);
  const widths = calculateSubagentColumnWidths(visibleSubagents, width);
  lines.push(...renderSubagentTableHeader(widths, width, theme));

  if (hiddenSubagents > 0) {
    lines.push(
      truncateToWidth(
        `  ${theme.fg("dim", `… ${hiddenSubagents} hidden subagent${hiddenSubagents === 1 ? "" : "s"}`)}`,
        width,
        "…",
        true,
      ),
    );
  }

  for (const [index, subagent] of visibleSubagents.entries()) {
    lines.push(renderSubagentTableRow(subagent, index + 1, widths, width, theme));
  }

  return lines;
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
    (mode === "compact" ? ["/subagents toggle", "ctrl+alt+u"] : getExpandedDashboardHintVariants());

  if (mode === "compact") {
    return renderCompactDashboardLines(
      activeSubagents,
      safeWidth,
      renderTheme,
      title,
      hints,
      maxRows,
    );
  }

  return renderExpandedDashboardLines(
    activeSubagents,
    safeWidth,
    renderTheme,
    title,
    hints,
    maxRows,
  );
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
  getSubagents?: () => RuntimeSubagent[];
  title?: string;
  getTitle?: () => string;
  done: () => void;
}): (tui: TUI, theme: Theme) => Component {
  return (tui, theme) => {
    let scrollOffset = 0;
    let lastViewportRows = 0;
    let lastTotalRows = 0;

    return {
      render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const subagents = input.getSubagents?.() ?? input.subagents;
        const content =
          renderSubagentDashboardLines(subagents, safeWidth, theme, {
            title: input.getTitle?.() ?? input.title,
            mode: "expanded",
            maxRows: Infinity,
            hints: [],
          }) ?? [];
        const viewportRows = Math.max(4, tui.terminal.rows - 4);
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
        const footerFill = Math.max(0, safeWidth - visibleWidth(helpText));
        return [
          ...visible.map((line) => truncateToWidth(line, safeWidth, "…")),
          ...Array.from({ length: Math.max(0, viewportRows - visible.length) }, () => ""),
          truncateToWidth(
            theme.fg("borderMuted", "─".repeat(footerFill)) + theme.fg("dim", helpText),
            safeWidth,
            "…",
            true,
          ),
        ];
      },
      handleInput(data: string): void {
        const maxScroll = Math.max(0, lastTotalRows - lastViewportRows);
        if (matchesKey(data, Key.escape) || data === "q") {
          input.done();
          return;
        }
        if (matchesKey(data, Key.up) || data === "k") {
          scrollOffset = Math.max(0, scrollOffset - 1);
        } else if (matchesKey(data, Key.down) || data === "j") {
          scrollOffset = Math.min(maxScroll, scrollOffset + 1);
        } else if (matchesKey(data, Key.pageUp) || data === "u") {
          scrollOffset = Math.max(0, scrollOffset - lastViewportRows);
        } else if (matchesKey(data, Key.pageDown) || data === "d") {
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
    if (!isTerminalSubagentStatus(subagent.status) || nextIds.has(subagent.sessionId)) {
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
