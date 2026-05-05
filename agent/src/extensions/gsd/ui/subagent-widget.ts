import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Container, Text, type Component, type TUI } from "@mariozechner/pi-tui";
import { createDefaultSubagentRuntimeHooks } from "../../../subagent-sdk/index.js";
import type { RuntimeSubagent } from "../../../subagent-sdk/index.js";
import type { SubagentRuntimeHooks } from "../../../subagent-sdk/runtime-hooks.js";
import { isStaleSessionReplacementContextError } from "../../session-replacement.js";

const GSD_SUBAGENT_OVERVIEW_WIDGET_KEY = "gsd-subagents-overview";
const TERMINAL_RETENTION_MS = 15_000;

function isTerminalStatus(status: RuntimeSubagent["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function buildOverviewLines(subagents: RuntimeSubagent[], theme: Theme): string[] {
  const runningCount = subagents.filter((subagent) => subagent.status === "running").length;
  const doneCount = subagents.filter((subagent) => isTerminalStatus(subagent.status)).length;
  const headline = [
    theme.fg("accent", theme.bold("GSD Subagents")),
    `${subagents.length} total`,
    runningCount > 0 ? `${runningCount} running` : undefined,
    doneCount > 0 ? `${doneCount} done` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(theme.fg("dim", " · "));
  return [headline];
}

function createWidgetComponent(lines: string[]) {
  return (_tui: TUI, _theme: Theme): Component => {
    const container = new Container();
    for (const line of lines) {
      container.addChild(new Text(line, 0, 0));
    }
    return container;
  };
}

export function createGsdSubagentRuntimeHooks(pi: ExtensionAPI): SubagentRuntimeHooks {
  const base = createDefaultSubagentRuntimeHooks(pi);
  const recentTerminalSubagents = new Map<string, RuntimeSubagent>();
  const expiryTimers = new Map<string, NodeJS.Timeout>();
  let lastCtx: ExtensionContext | undefined;
  let activeSubagents: RuntimeSubagent[] = [];

  const clearWidgets = (ctx: ExtensionContext): void => {
    ctx.ui.setWidget(GSD_SUBAGENT_OVERVIEW_WIDGET_KEY, undefined, { placement: "aboveEditor" });
  };

  const renderMergedWidgets = (ctx: ExtensionContext | undefined): void => {
    if (ctx?.hasUI !== true) {
      return;
    }

    const now = Date.now();
    const retained = Array.from(recentTerminalSubagents.values()).filter((subagent) => {
      const completedAt = subagent.completedAt ?? subagent.updatedAt;
      return now - completedAt <= TERMINAL_RETENTION_MS;
    });
    const merged = [...activeSubagents, ...retained]
      .filter(
        (subagent, index, all) =>
          all.findIndex((candidate) => candidate.sessionId === subagent.sessionId) === index,
      )
      .toSorted((left, right) => left.startedAt - right.startedAt);

    if (merged.length === 0) {
      clearWidgets(ctx);
      return;
    }

    try {
      const overviewLines = buildOverviewLines(merged, ctx.ui.theme);
      ctx.ui.setWidget(GSD_SUBAGENT_OVERVIEW_WIDGET_KEY, createWidgetComponent(overviewLines), {
        placement: "aboveEditor",
      });
    } catch (error) {
      if (!isStaleSessionReplacementContextError(error)) {
        throw error;
      }
    }
  };

  const scheduleExpiry = (sessionId: string): void => {
    const existingTimer = expiryTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      expiryTimers.delete(sessionId);
      recentTerminalSubagents.delete(sessionId);
      renderMergedWidgets(lastCtx);
    }, TERMINAL_RETENTION_MS);
    timer.unref?.();
    expiryTimers.set(sessionId, timer);
  };

  return {
    async persistState(state) {
      await base.persistState(state);
      if (isTerminalStatus(state.status)) {
        recentTerminalSubagents.set(state.sessionId, {
          ...state,
          modeLabel: state.mode ?? "worker",
        });
        scheduleExpiry(state.sessionId);
      } else {
        recentTerminalSubagents.delete(state.sessionId);
        const existingTimer = expiryTimers.get(state.sessionId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          expiryTimers.delete(state.sessionId);
        }
      }
    },
    persistMessage(entry) {
      return base.persistMessage(entry);
    },
    emitStatusMessage(options) {
      base.emitStatusMessage(options);
    },
    renderWidget(ctx, subagents) {
      lastCtx = ctx;
      activeSubagents = subagents;
      renderMergedWidgets(ctx);
    },
  };
}
