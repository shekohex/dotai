import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { GOAL_STATUS_KEY } from "../goal/types.js";
import { OPENAI_BETTER_STATUS_KEY } from "../openai-better/types.js";
import { getContextPruneFooterState } from "../context-prune/public-api.js";
import { isStaleSessionReplacementContextError } from "../session-replacement.js";
import { appendGoalRuntimeStatus } from "./goal-status.js";
import { shortenHome } from "./path.js";
import { formatDuration } from "./tps.js";
import type { CoreUIState } from "./types.js";
import { colorizeCoreUIShimmerFrame } from "./working-indicator.js";

const FOOTER_SIDE_PADDING = 1;
const FOOTER_TOP_PADDING = 1;
const MEMORY_ICON = "\u{F035B}";
const PRUNE_ICON = "\u{F0A6B}";
const TPS_ICON = "\u{F04C5}";

type Theme = ExtensionContext["ui"]["theme"];
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export function bindCoreUI(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  state: CoreUIState,
  setRequestRender: (requestRender: (() => void) | undefined) => void,
): void {
  ctx.ui.setHeader(() => ({
    render: () => [],
    invalidate() {},
  }));

  ctx.ui.setFooter((tui, theme, footerData) => {
    const requestRender = () => {
      try {
        tui.requestRender();
      } catch (error) {
        if (!isStaleSessionReplacementContextError(error)) {
          throw error;
        }
      }
    };
    setRequestRender(requestRender);

    const unsubscribe = footerData.onBranchChange(requestRender);

    return {
      dispose() {
        unsubscribe();
        setRequestRender(undefined);
      },
      invalidate() {},
      render(width: number): string[] {
        try {
          const left = buildProjectStatus(theme, footerData.getGitBranch(), state, ctx);
          const leftBottomStatus = joinFooterParts(
            theme,
            buildTPSStatus(theme, state),
            buildSessionElapsedStatus(theme, state),
            buildWorkflowStatus(theme, state),
          );
          const leftBottom = appendGoalRuntimeStatus(
            theme,
            leftBottomStatus,
            footerData.getExtensionStatuses().get(GOAL_STATUS_KEY),
          );
          const rightTop = buildModelStatus(
            theme,
            ctx,
            pi,
            state,
            footerData.getExtensionStatuses().get(OPENAI_BETTER_STATUS_KEY),
          );
          const rightBottom = buildUsageStatus(theme, ctx, state.totalCost);

          return [
            ...Array.from({ length: FOOTER_TOP_PADDING }, () => " ".repeat(Math.max(0, width))),
            composeFooterLine(left, rightTop, width),
            composeFooterLine(leftBottom, rightBottom, width, { priority: "left" }),
          ];
        } catch (error) {
          if (!isStaleSessionReplacementContextError(error)) {
            throw error;
          }

          return [];
        }
      },
    };
  });
}

function formatContextPruneStatus(
  theme: Theme,
  state: NonNullable<ReturnType<typeof getContextPruneFooterState>>,
): string {
  if (state.overrideText !== undefined && state.overrideText.length > 0) {
    return colorizeCoreUIShimmerFrame(PRUNE_ICON);
  }

  return state.config.enabled ? theme.fg("success", PRUNE_ICON) : theme.fg("error", PRUNE_ICON);
}

export function buildTPSStatus(theme: Theme, state: CoreUIState): string {
  if (!state.tpsVisible || !state.tps) {
    return "";
  }

  const icon = colorTPSIcon(
    theme,
    state.tps.current,
    state.tps.sessionMin,
    state.tps.median,
    state.tps.sessionMax,
  );
  return `${icon}${theme.fg("dim", " ")}${theme.fg("accent", state.tps.current.toFixed(1))}`;
}

export function buildSessionElapsedStatus(theme: Theme, state: CoreUIState): string {
  if (state.tpsElapsedMs <= 0) {
    return "";
  }
  return theme.fg("dim", formatDuration(state.tpsElapsedMs));
}

function buildWorkflowStatus(theme: Theme, state: CoreUIState): string {
  const workflow = state.workflowStatus;
  if (workflow === undefined) return "";
  const phase =
    workflow.phase !== undefined && workflow.phase.length > 0 ? ` · ${workflow.phase}` : "";
  return theme.italic(
    theme.fg("accent", `Workflow ${workflow.workflowName} ${workflow.elapsedSeconds}s${phase}`),
  );
}

function joinFooterParts(theme: Theme, ...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join(theme.fg("dim", " · "));
}

function colorTPSIcon(
  theme: Theme,
  current: number,
  min: number,
  median: number,
  max: number,
): string {
  if (max <= min) {
    return theme.fg("muted", TPS_ICON);
  }
  if (current >= max * 0.9) {
    return theme.bold(theme.fg("error", TPS_ICON));
  }
  if (current >= median) {
    return theme.fg("warning", TPS_ICON);
  }
  return theme.fg("success", TPS_ICON);
}

function buildProjectStatus(
  theme: Theme,
  branch: string | null,
  state: CoreUIState,
  ctx: ExtensionContext,
): string {
  const projectLabel = theme.fg("dim", state.repoSlug ?? shortenHome(ctx.sessionManager.getCwd()));
  const refLabel = resolveRefLabel(branch, state.worktreeName);

  if (refLabel === undefined || refLabel.length === 0) {
    return projectLabel;
  }

  const branchText = theme.fg("dim", `${refLabel}${state.dirty ? "*" : ""}`);
  const addedText = state.addedLines > 0 ? theme.fg("success", ` +${state.addedLines}`) : "";
  const removedText = state.removedLines > 0 ? theme.fg("error", ` -${state.removedLines}`) : "";
  const aheadText = state.aheadCommits > 0 ? theme.fg("success", ` ↑${state.aheadCommits}`) : "";
  const behindText = state.behindCommits > 0 ? theme.fg("warning", ` ↓${state.behindCommits}`) : "";

  return `${projectLabel}${theme.fg("dim", " (")}${branchText}${addedText}${removedText}${aheadText}${behindText}${theme.fg("dim", ")")}`;
}

function resolveRefLabel(
  branch: string | null,
  worktreeName: string | undefined,
): string | undefined {
  if (branch !== null && branch !== "detached") {
    return branch;
  }

  if (worktreeName !== undefined && worktreeName.length > 0) {
    return worktreeName;
  }

  return branch === "detached" ? "detached" : undefined;
}

function buildModelStatus(
  theme: Theme,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  state: CoreUIState,
  fastStatus: string | undefined,
): string {
  const modeName = state.activeMode;
  const modePrefix =
    modeName !== undefined && modeName.length > 0
      ? `${colorModeLabel(theme, modeName, state.activeModeColor)}${theme.fg("dim", " ")}`
      : "";
  const providerName = ctx.model?.provider ?? "no-provider";
  const modelName = ctx.model?.id ?? "no-model";
  const thinkingLevel: ThinkingLevel =
    ctx.model?.reasoning === true ? pi.getThinkingLevel() : "off";

  const suffix =
    fastStatus !== undefined && fastStatus.length > 0
      ? `${theme.fg("dim", " · ")}${fastStatus}`
      : "";

  return (
    modePrefix +
    theme.fg("dim", `${providerName}/${modelName}:`) +
    colorThinkingLevel(theme, thinkingLevel) +
    suffix
  );
}

function colorModeLabel(theme: Theme, mode: string, color?: ThemeColor): string {
  if (color !== undefined) {
    return theme.fg(color, mode);
  }

  return theme.fg(mode === "custom" ? "warning" : "accent", mode);
}

function colorThinkingLevel(theme: Theme, level: ThinkingLevel): string {
  switch (level) {
    case "off":
      return theme.fg("thinkingOff", "off");
    case "minimal":
      return theme.fg("thinkingMinimal", "minimal");
    case "low":
      return theme.fg("thinkingLow", "low");
    case "medium":
      return theme.fg("thinkingMedium", "medium");
    case "high":
      return theme.fg("thinkingHigh", "high");
    case "xhigh":
      return theme.fg("thinkingXhigh", "xhigh");
    default:
      return theme.fg("thinkingOff", "off");
  }
}

function buildUsageStatus(theme: Theme, ctx: ExtensionContext, totalCost: number): string {
  const contextAndCost = formatContextAndCost(theme, ctx, totalCost);
  const parts = [contextAndCost];
  const pruneState = getContextPruneFooterState();

  if (pruneState !== undefined) {
    parts.push(formatContextPruneStatus(theme, pruneState));
  }

  return parts.join(theme.fg("dim", " · "));
}

function formatContextAndCost(theme: Theme, ctx: ExtensionContext, totalCost: number): string {
  const usage = ctx.getContextUsage();
  const tokens = usage?.tokens ?? null;
  const percent = usage?.percent ?? null;
  const tokensText = tokens === null ? "?" : formatTokens(tokens);
  const percentText = percent === null ? "?" : `${percent.toFixed(0)}%`;

  return (
    `${theme.fg("dim", `${MEMORY_ICON} `)}${theme.fg("dim", tokensText)}` +
    `${theme.fg("dim", " (")}${styleContextPercent(theme, percent, percentText)}${theme.fg("dim", ") · ")}` +
    theme.fg("dim", `$${totalCost.toFixed(2)}`)
  );
}

function styleContextPercent(theme: Theme, percent: number | null, text: string): string {
  if (percent === null || !Number.isFinite(percent)) {
    return theme.fg("muted", text);
  }

  if (percent >= 90) {
    return theme.bold(theme.fg("error", text));
  }

  if (percent >= 75) {
    return theme.bold(theme.fg("warning", text));
  }

  if (percent >= 60) {
    return theme.fg("warning", text);
  }

  return theme.fg("dim", text);
}

function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) {
    return "?";
  }

  if (count < 1000) {
    return `${Math.round(count)}`;
  }

  if (count < 10000) {
    return `${(count / 1000).toFixed(1)}K`;
  }

  if (count < 1000000) {
    return `${Math.round(count / 1000)}K`;
  }

  if (count < 10000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }

  return `${Math.round(count / 1000000)}M`;
}

type FooterLinePriority = "left" | "right";

export function composeFooterLine(
  left: string,
  right: string,
  width: number,
  options: { priority?: FooterLinePriority } = {},
): string {
  if (width <= 0) {
    return "";
  }

  const sidePadding = " ".repeat(Math.max(0, FOOTER_SIDE_PADDING));
  const innerWidth = Math.max(0, width - sidePadding.length * 2);

  if (innerWidth <= 0) {
    return truncateToWidth(`${sidePadding}${left}${right}${sidePadding}`, width, "");
  }

  if (left.length === 0) {
    return `${sidePadding}${truncateToWidth(right, innerWidth, "")}${sidePadding}`;
  }

  if (right.length === 0) {
    return `${sidePadding}${truncateToWidth(left, innerWidth, "…")}${sidePadding}`;
  }

  if (options.priority === "left") {
    return composeLeftPriorityFooterLine(left, right, innerWidth, sidePadding);
  }

  const rightWidth = visibleWidth(right);
  if (rightWidth >= innerWidth) {
    return `${sidePadding}${truncateToWidth(right, innerWidth, "")}${sidePadding}`;
  }

  const gap = 1;
  const leftBudget = Math.max(0, innerWidth - rightWidth - gap);
  const leftPart = truncateToWidth(left, leftBudget, "…");
  const leftWidth = visibleWidth(leftPart);
  const paddingWidth = Math.max(gap, innerWidth - leftWidth - rightWidth);

  return `${sidePadding}${leftPart}${" ".repeat(paddingWidth)}${right}${sidePadding}`;
}

function composeLeftPriorityFooterLine(
  left: string,
  right: string,
  innerWidth: number,
  sidePadding: string,
): string {
  const leftPart = truncateToWidth(left, innerWidth, "…");
  const leftWidth = visibleWidth(leftPart);
  const remainingWidth = innerWidth - leftWidth;
  if (remainingWidth <= 1) {
    return `${sidePadding}${leftPart}${sidePadding}`;
  }

  const rightPart = truncateToWidth(right, remainingWidth - 1, "");
  if (rightPart.length === 0) {
    return `${sidePadding}${leftPart}${sidePadding}`;
  }

  return `${sidePadding}${leftPart}${" ".repeat(Math.max(1, remainingWidth - visibleWidth(rightPart)))}${rightPart}${sidePadding}`;
}
