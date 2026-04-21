import fs from "node:fs/promises";
import type { RuntimeSubagent } from "../types.js";
import {
  getParentInjectedInputMarkerPath,
  isAutoExitTimeoutModeActive,
  readChildSessionOutcome,
  readChildSessionStatusDetails,
  SUBAGENT_PARENT_INPUT_GRACE_MS,
} from "../persistence.js";
import { formatStructuredOutputError } from "./base.js";
import { SubagentRuntimeMessaging } from "./messaging.js";

function pathDirname(inputPath: string): string {
  const slashIndex = inputPath.lastIndexOf("/");
  const backslashIndex = inputPath.lastIndexOf("\\");
  const separatorIndex = Math.max(slashIndex, backslashIndex);
  if (separatorIndex <= 0) {
    return ".";
  }

  return inputPath.slice(0, separatorIndex);
}

export abstract class SubagentRuntimeMonitoring extends SubagentRuntimeMessaging {
  protected ensurePolling(): void {
    if (this.pollTimer || this.activeSessionIds.size === 0) {
      return;
    }

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, 2000);
    this.pollTimer.unref?.();
  }

  private ensureWidgetTimer(): void {
    if (this.ctx?.hasUI !== true) {
      if (this.widgetTimer) {
        clearInterval(this.widgetTimer);
        this.widgetTimer = undefined;
      }
      return;
    }

    const needsCountdownRefresh = Array.from(this.activeSessionIds).some((sessionId) => {
      const state = this.states.get(sessionId);
      return (
        state?.status === "idle" &&
        state.autoExit &&
        state.autoExitTimeoutActive === true &&
        state.autoExitTimeoutMs !== undefined &&
        state.autoExitDeadlineAt !== undefined
      );
    });

    if (needsCountdownRefresh) {
      if (!this.widgetTimer) {
        this.widgetTimer = setInterval(() => {
          this.refreshWidget();
        }, 1000);
        this.widgetTimer.unref?.();
      }
      return;
    }

    if (this.widgetTimer) {
      clearInterval(this.widgetTimer);
      this.widgetTimer = undefined;
    }
  }

  private async poll(): Promise<void> {
    if (this.activeSessionIds.size === 0 || this.restoring) {
      this.stopPollingIfIdle();
      this.refreshWidget();
      return;
    }

    for (const sessionId of Array.from(this.activeSessionIds.values())) {
      const state = this.states.get(sessionId);
      if (!state) {
        this.activeSessionIds.delete(sessionId);
        continue;
      }

      const alive = await this.hasLivePane(state);
      if (alive) {
        await this.syncLiveState(state, "updated");
        continue;
      }

      await this.finalizeInactiveSubagent(state);
    }

    this.refreshWidget();
    this.stopPollingIfIdle();
  }

  protected async finalizeInactiveSubagent(state: RuntimeSubagent): Promise<void> {
    const outcome = await readChildSessionOutcome(state.sessionPath);
    const now = Date.now();
    const failed = outcome.failed || outcome.structuredError !== undefined;
    const terminal: RuntimeSubagent = {
      ...state,
      event: failed ? "failed" : "completed",
      status: failed ? "failed" : "completed",
      summary: outcome.summary,
      structured: outcome.structured,
      structuredError: outcome.structuredError,
      autoExitDeadlineAt: undefined,
      autoExitTimeoutActive: state.autoExitTimeoutActive,
      updatedAt: now,
      completedAt: now,
    };

    this.states.set(terminal.sessionId, terminal);
    this.activeSessionIds.delete(terminal.sessionId);
    await this.hooks.persistState(terminal);
    this.stopPollingIfIdle();

    const structuredErrorText = formatStructuredOutputError(terminal.structuredError);
    const messageText =
      terminal.status === "completed"
        ? `Subagent ${terminal.name} (${terminal.sessionId}) completed.\n\n${terminal.summary ?? "No summary available."}`
        : `Subagent ${terminal.name} (${terminal.sessionId}) failed.\n\n${structuredErrorText ?? terminal.summary ?? "No summary available."}`;

    this.hooks.emitStatusMessage({ content: messageText, triggerTurn: true });
  }

  protected async markParentInjectedInput(sessionId: string): Promise<void> {
    const markerPath = getParentInjectedInputMarkerPath(sessionId);
    const payload = JSON.stringify({ expiresAt: Date.now() + SUBAGENT_PARENT_INPUT_GRACE_MS });

    await fs.mkdir(pathDirname(markerPath), { recursive: true }).catch(() => {});
    await fs.writeFile(markerPath, payload, "utf8").catch(() => {});
  }

  protected stopPollingIfIdle(): void {
    if (this.activeSessionIds.size > 0 || !this.pollTimer) {
      return;
    }

    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  protected refreshWidget(): void {
    if (this.ctx?.hasUI !== true) {
      this.ensureWidgetTimer();
      return;
    }

    const activeSubagents = Array.from(this.activeSessionIds.values())
      .map((sessionId) => this.states.get(sessionId))
      .filter((state): state is RuntimeSubagent => state !== undefined)
      .toSorted((left, right) => left.startedAt - right.startedAt);

    this.hooks.renderWidget(this.ctx, activeSubagents);
    this.ensureWidgetTimer();
  }

  protected async syncLiveState(
    state: RuntimeSubagent,
    event: RuntimeSubagent["event"],
  ): Promise<RuntimeSubagent> {
    const liveStatus = await readChildSessionStatusDetails(state.sessionPath);
    const autoExitTimeoutMs = state.autoExitTimeoutMs ?? 30_000;
    const autoExitTimeoutActive = state.autoExit && isAutoExitTimeoutModeActive(state.sessionId);
    const nextState: RuntimeSubagent = {
      ...state,
      event,
      status: liveStatus.status,
      autoExitTimeoutActive,
      updatedAt: Date.now(),
      autoExitDeadlineAt:
        liveStatus.status === "idle" && state.autoExit && autoExitTimeoutActive
          ? (state.autoExitDeadlineAt ?? (liveStatus.idleSinceAt ?? Date.now()) + autoExitTimeoutMs)
          : undefined,
    };

    this.states.set(nextState.sessionId, nextState);
    if (
      nextState.status !== state.status ||
      nextState.event !== state.event ||
      nextState.autoExitTimeoutActive !== state.autoExitTimeoutActive ||
      nextState.autoExitDeadlineAt !== state.autoExitDeadlineAt
    ) {
      await this.hooks.persistState(nextState);
    }

    return nextState;
  }
}
