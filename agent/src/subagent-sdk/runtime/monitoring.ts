import fs from "node:fs/promises";
import { isStaleSessionReplacementContextError } from "../../extensions/session-replacement.js";
import type { RuntimeSubagent, SubagentActivityEntry } from "../types.js";
import {
  cleanupSubagentPersistenceArtifacts,
  getParentInjectedInputMarkerPath,
  isAutoExitTimeoutModeActive,
  readLatestChildActivityState,
  readEphemeralChildSessionOutcomeBySessionId,
  readEphemeralChildSessionStatusDetails,
  readChildSessionOutcome,
  readChildSessionStatusDetails,
  SUBAGENT_PARENT_INPUT_GRACE_MS,
} from "../persistence.js";
import { formatStructuredOutputError, formatSubagentFailureFallback } from "./base.js";
import { SubagentRuntimeMessaging } from "./messaging.js";

const SUBAGENT_POLL_INTERVAL_MS = 250;

function buildTerminalActivity(
  state: RuntimeSubagent,
  status: "completed" | "failed" | "cancelled",
  summary: string | undefined,
): SubagentActivityEntry {
  const latestActivity =
    state.sessionPath === undefined
      ? state.activity
      : readLatestChildActivityState(state.sessionPath);
  const updatedAt = Date.now();

  return {
    sessionId: state.sessionId,
    kind: status,
    label: status === "completed" ? "done" : status,
    detail: summary,
    toolName: latestActivity?.toolName,
    startedAt: latestActivity?.startedAt ?? state.startedAt,
    updatedAt,
    done: true,
  };
}

function resolveCompletionDelivery(state: RuntimeSubagent): {
  enabled: boolean;
  deliverAs: "steer" | "followUp";
  triggerTurn: boolean;
} {
  if (state.completion === false) {
    return { enabled: false, deliverAs: "steer", triggerTurn: false };
  }

  return {
    enabled: true,
    deliverAs: state.completion?.deliverAs ?? "steer",
    triggerTurn: state.completion?.triggerTurn ?? true,
  };
}

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
  private pollRunning = false;

  private hasActiveUiContext(): boolean {
    try {
      return this.ctx?.hasUI === true;
    } catch (error) {
      if (isStaleSessionReplacementContextError(error)) {
        this.ctx = undefined;
        return false;
      }

      throw error;
    }
  }

  protected ensurePolling(): void {
    if (this.disposed) {
      return;
    }

    if (this.pollTimer || this.activeSessionIds.size === 0) {
      return;
    }

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, SUBAGENT_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private ensureWidgetTimer(): void {
    if (this.disposed) {
      if (this.widgetTimer) {
        clearInterval(this.widgetTimer);
        this.widgetTimer = undefined;
      }
      return;
    }

    if (!this.hasActiveUiContext()) {
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
    if (this.pollRunning) {
      return;
    }
    this.pollRunning = true;
    try {
      await this.pollOnce();
    } finally {
      this.pollRunning = false;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.disposed) {
      return;
    }

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
      if (this.disposed) {
        return;
      }
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
    if (this.disposed) {
      return;
    }

    const outcome =
      state.sessionPath === undefined
        ? await readEphemeralChildSessionOutcomeBySessionId(state.sessionId)
        : await readChildSessionOutcome(state.sessionPath);
    if (this.disposed) {
      return;
    }

    const now = Date.now();
    const failed = outcome.failed || outcome.structuredError !== undefined;
    const terminal: RuntimeSubagent = {
      ...state,
      event: failed ? "failed" : "completed",
      status: failed ? "failed" : "completed",
      activity: buildTerminalActivity(state, failed ? "failed" : "completed", outcome.summary),
      summary: outcome.summary,
      structured: outcome.structured,
      structuredError: outcome.structuredError,
      autoExitDeadlineAt: undefined,
      autoExitTimeoutActive: state.autoExitTimeoutActive,
      updatedAt: now,
      completedAt: now,
    };

    await this.hooks.persistState(terminal);

    this.states.set(terminal.sessionId, terminal);
    this.activeSessionIds.delete(terminal.sessionId);
    cleanupSubagentPersistenceArtifacts(terminal.sessionId);
    this.stopPollingIfIdle();

    const structuredErrorText = formatStructuredOutputError(terminal.structuredError);
    const ephemeralSuffix =
      terminal.persisted === false
        ? "\n\nThis subagent was ephemeral (persisted: false) and cannot be messaged or resumed. Start a new subagent if you need to run it again."
        : "";
    const messageText =
      terminal.status === "completed"
        ? `Subagent ${terminal.name} (${terminal.sessionId}) completed.\n\n${terminal.summary ?? "No summary available."}${ephemeralSuffix}`
        : `Subagent ${terminal.name} (${terminal.sessionId}) failed.\n\n${structuredErrorText ?? formatSubagentFailureFallback(terminal)}${ephemeralSuffix}`;

    const completionDelivery = resolveCompletionDelivery(terminal);
    if (completionDelivery.enabled) {
      this.hooks.emitStatusMessage({
        content: messageText,
        deliverAs: completionDelivery.deliverAs,
        triggerTurn: completionDelivery.triggerTurn,
      });
    }
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
    if (this.disposed) {
      return;
    }

    if (!this.hasActiveUiContext()) {
      this.ensureWidgetTimer();
      return;
    }

    const visibleSubagents = Array.from(this.activeSessionIds.values())
      .map((sessionId) => this.states.get(sessionId))
      .filter((state): state is RuntimeSubagent => state !== undefined)
      .toSorted((left, right) => left.startedAt - right.startedAt);

    this.hooks.renderWidget(this.ctx, visibleSubagents);
    this.ensureWidgetTimer();
  }

  protected async syncLiveState(
    state: RuntimeSubagent,
    event: RuntimeSubagent["event"],
  ): Promise<RuntimeSubagent> {
    if (this.disposed) {
      return state;
    }

    const liveStatus =
      state.sessionPath === undefined
        ? await readEphemeralChildSessionStatusDetails()
        : await readChildSessionStatusDetails(state.sessionPath);
    if (this.disposed) {
      return state;
    }

    const autoExitTimeoutMs = state.autoExitTimeoutMs ?? 30_000;
    const autoExitTimeoutActive = state.autoExit && isAutoExitTimeoutModeActive(state.sessionId);
    const nextState: RuntimeSubagent = {
      ...state,
      event,
      status: liveStatus.status,
      activity:
        state.sessionPath === undefined
          ? state.activity
          : readLatestChildActivityState(state.sessionPath),
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
