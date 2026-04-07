import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { OPENUSAGE_STATUS_KEY } from "../openusage/types.js";
import { shortenHome } from "./path.js";
import type { CoreUIState } from "./types.js";

const FOOTER_SIDE_PADDING = 1;

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
    const requestRender = () => tui.requestRender();
    setRequestRender(requestRender);

    const unsubscribe = footerData.onBranchChange(requestRender);

    return {
      dispose() {
        unsubscribe();
        setRequestRender(undefined);
      },
      invalidate() {},
      render(width: number): string[] {
        const left = buildProjectStatus(
          theme,
          footerData.getGitBranch(),
          state,
          ctx,
        );
        const rightTop = buildModelStatus(theme, ctx, pi);
        const rightBottom = buildUsageStatus(
          theme,
          ctx,
          state.totalCost,
          footerData.getExtensionStatuses().get(OPENUSAGE_STATUS_KEY),
        );

        return [
          composeFooterLine(left, rightTop, width),
          composeFooterLine("", rightBottom, width),
        ];
      },
    };
  });
}

function buildProjectStatus(
  theme: Theme,
  branch: string | null,
  state: CoreUIState,
  ctx: ExtensionContext,
): string {
  const projectLabel = theme.fg(
    "dim",
    state.repoSlug ?? shortenHome(ctx.sessionManager.getCwd()),
  );
  const refLabel = resolveRefLabel(branch, state.worktreeName);

  if (!refLabel) {
    return projectLabel;
  }

  const branchText = theme.fg("dim", `${refLabel}${state.dirty ? "*" : ""}`);
  const addedText =
    state.addedLines > 0 ? theme.fg("success", ` +${state.addedLines}`) : "";
  const removedText =
    state.removedLines > 0
      ? theme.fg("error", ` -${state.removedLines}`)
      : "";
  const aheadText =
    state.aheadCommits > 0
      ? theme.fg("success", ` ↑${state.aheadCommits}`)
      : "";
  const behindText =
    state.behindCommits > 0
      ? theme.fg("warning", ` ↓${state.behindCommits}`)
      : "";

  return `${projectLabel}${theme.fg("dim", " (")}${branchText}${addedText}${removedText}${aheadText}${behindText}${theme.fg("dim", ")")}`;
}

function resolveRefLabel(
  branch: string | null,
  worktreeName: string | undefined,
): string | undefined {
  if (branch && branch !== "detached") {
    return branch;
  }

  if (worktreeName) {
    return worktreeName;
  }

  return branch === "detached" ? "detached" : undefined;
}

function buildModelStatus(
  theme: Theme,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): string {
  const providerName = ctx.model?.provider ?? "no-provider";
  const modelName = ctx.model?.id ?? "no-model";
  const thinkingLevel: ThinkingLevel = ctx.model?.reasoning
    ? pi.getThinkingLevel()
    : "off";

  return (
    theme.fg("dim", `${providerName}/${modelName}:`) +
    colorThinkingLevel(theme, thinkingLevel)
  );
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
  }
}

function buildUsageStatus(
  theme: Theme,
  ctx: ExtensionContext,
  totalCost: number,
  usageStatus: string | undefined,
): string {
  const contextAndCost = formatContextAndCost(theme, ctx, totalCost);
  return usageStatus
    ? `${contextAndCost}${theme.fg("dim", " · ")}${usageStatus}`
    : contextAndCost;
}

function formatContextAndCost(
  theme: Theme,
  ctx: ExtensionContext,
  totalCost: number,
): string {
  const usage = ctx.getContextUsage();
  const tokens = usage?.tokens ?? null;
  const percent = usage?.percent ?? null;
  const tokensText = tokens === null ? "?" : formatTokens(tokens);
  const percentText = percent === null ? "?" : `${percent.toFixed(0)}%`;

  return (
    `${theme.fg("dim", "ctx ")}${theme.fg("dim", tokensText)}` +
    `${theme.fg("dim", " (")}${styleContextPercent(theme, percent, percentText)}${theme.fg("dim", ") · ")}` +
    `${theme.fg("dim", `$${totalCost.toFixed(2)}`)}`
  );
}

function styleContextPercent(
  theme: Theme,
  percent: number | null,
  text: string,
): string {
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

function composeFooterLine(left: string, right: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  const sidePadding = " ".repeat(Math.max(0, FOOTER_SIDE_PADDING));
  const innerWidth = Math.max(0, width - sidePadding.length * 2);

  if (innerWidth <= 0) {
    return truncateToWidth(
      `${sidePadding}${left}${right}${sidePadding}`,
      width,
      "",
    );
  }

  const rightWidth = visibleWidth(right);
  if (rightWidth >= innerWidth) {
    return `${sidePadding}${truncateToWidth(right, innerWidth, "")}${sidePadding}`;
  }

  const gap = left && right ? 1 : 0;
  const leftBudget = Math.max(0, innerWidth - rightWidth - gap);
  const leftPart = truncateToWidth(left, leftBudget, "…");
  const leftWidth = visibleWidth(leftPart);
  const paddingWidth = Math.max(gap, innerWidth - leftWidth - rightWidth);

  return `${sidePadding}${leftPart}${" ".repeat(paddingWidth)}${right}${sidePadding}`;
}
