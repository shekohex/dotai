import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import {
  buildContextTransferPrompt,
  generateContextTransferSummary,
  getConversationMessages,
} from "../extensions/session-launch-utils.js";
import type { LaunchCommandBuilder } from "./launch.js";
import { resolveSubagentMode } from "./modes.js";
import type { MuxAdapter } from "./mux.js";
import {
  createChildSessionFile,
  getParentInjectedInputMarkerPath,
  isAutoExitTimeoutModeActive,
  readChildSessionOutcome,
  readChildSessionStatusDetails,
  reduceRuntimeSubagents,
  SUBAGENT_PARENT_INPUT_GRACE_MS,
} from "./persistence.js";
import { createDefaultSubagentRuntimeHooks, type SubagentRuntimeHooks } from "./runtime-hooks.js";
import {
  cloneRuntimeSubagent,
  type CancelSubagentParams,
  type ChildBootstrapState,
  type MessageSubagentParams,
  type MessageSubagentResult,
  type ResumeSubagentParams,
  type ResumeSubagentResult,
  type RuntimeSubagent,
  type StructuredOutputError,
  type StartSubagentParams,
  type StartSubagentResult,
  type SubagentToolProgressDetails,
} from "./types.js";

function runtimeSubagentError(
  action: "start" | "resume" | "message" | "cancel",
  detail: string,
): Error {
  return new Error(`subagent ${action} failed: ${detail}`);
}

function unknownSessionError(action: "message" | "cancel" | "resume", sessionId: string): Error {
  return runtimeSubagentError(
    action,
    `sessionId ${sessionId} was not found in this parent session. Use subagent list or a prior result to get the full UUID v4 sessionId.`,
  );
}

function formatStructuredOutputError(error: StructuredOutputError | undefined): string | undefined {
  if (!error) {
    return undefined;
  }

  return `${error.message} (code: ${error.code}, attempts: ${error.attempts}, retryCount: ${error.retryCount})`;
}

type ResumeExecutionOptions = {
  progressAction?: "message" | "start";
  errorAction?: "resume" | "message";
};

function isTerminalStatus(status: RuntimeSubagent["status"]): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function emitProgressUpdate(
  onUpdate: AgentToolUpdateCallback<any> | undefined,
  details: SubagentToolProgressDetails,
): void {
  const preview = details.preview?.trim();
  onUpdate?.({
    content: preview ? [{ type: "text", text: preview }] : [],
    details,
  });
}

export class SubagentRuntime {
  private ctx?: ExtensionContext;
  private states = new Map<string, RuntimeSubagent>();
  private activeSessionIds = new Set<string>();
  private pollTimer?: NodeJS.Timeout;
  private widgetTimer?: NodeJS.Timeout;
  private restoring = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly adapter: MuxAdapter,
    private readonly buildLaunchCommand: LaunchCommandBuilder,
    private readonly hooks: SubagentRuntimeHooks = createDefaultSubagentRuntimeHooks(pi),
  ) {}

  private toPublicState(state: RuntimeSubagent): RuntimeSubagent {
    return cloneRuntimeSubagent(state);
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.widgetTimer) {
      clearInterval(this.widgetTimer);
      this.widgetTimer = undefined;
    }
  }

  listStates(): RuntimeSubagent[] {
    return Array.from(this.states.values())
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((state) => this.toPublicState(state));
  }

  private getStateOrThrow(
    action: "resume" | "message" | "cancel",
    sessionId: string,
  ): RuntimeSubagent {
    const state = this.states.get(sessionId);
    if (!state) {
      throw unknownSessionError(action, sessionId);
    }

    return state;
  }

  private async hasLivePane(state: RuntimeSubagent): Promise<boolean> {
    return state.paneId ? await this.adapter.paneExists(state.paneId).catch(() => false) : false;
  }

  async restore(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    this.restoring = true;

    try {
      const restored = reduceRuntimeSubagents(
        ctx.sessionManager.getBranch(),
        ctx.sessionManager.getSessionId(),
      );
      this.states.clear();
      this.activeSessionIds.clear();

      for (const state of restored.values()) {
        this.states.set(state.sessionId, state);

        if (isTerminalStatus(state.status)) {
          continue;
        }

        const paneAlive = await this.hasLivePane(state);
        if (paneAlive) {
          this.activeSessionIds.add(state.sessionId);
          await this.syncLiveState(state, "restored");
          continue;
        }

        await this.finalizeInactiveSubagent(state);
      }

      this.ensurePolling();
      this.refreshWidget();
    } finally {
      this.restoring = false;
    }
  }

  async spawn(
    params: StartSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
    signal?: AbortSignal,
  ): Promise<StartSubagentResult> {
    const availability = await this.adapter.isAvailable();
    if (!availability) {
      throw runtimeSubagentError(
        "start",
        "tmux is not available in the current session. Run the parent pi session inside tmux before starting a subagent.",
      );
    }

    const mode = await resolveSubagentMode(this.pi, ctx, {
      mode: params.mode,
      cwd: params.cwd,
      autoExit: params.autoExit,
    });
    if (!mode.value) {
      throw new Error(mode.error);
    }

    const startedAt = Date.now();
    const parentSessionId = ctx.sessionManager.getSessionId();
    const parentSessionPath = ctx.sessionManager.getSessionFile();
    const sessionId = randomUUID();

    let prompt = params.task;
    if (params.handoff) {
      emitProgressUpdate(onUpdate, {
        action: "start",
        phase: "handoff",
        statusText: `Preparing handoff for ${params.name}`,
        durationMs: 0,
      });

      const summary = await generateContextTransferSummary(
        ctx,
        params.task,
        getConversationMessages(ctx),
        signal,
        ({ summary: partialSummary }) => {
          emitProgressUpdate(onUpdate, {
            action: "start",
            phase: "handoff",
            statusText: `Generating handoff prompt for ${params.name}`,
            preview: partialSummary,
            durationMs: Date.now() - startedAt,
          });
        },
      );
      if (summary.error) {
        throw new Error(summary.error);
      }
      if (summary.aborted || !summary.summary) {
        throw new Error("Cancelled");
      }

      prompt = buildContextTransferPrompt(summary.summary, parentSessionPath);
    }

    emitProgressUpdate(onUpdate, {
      action: "start",
      phase: "launch",
      statusText: `Launching ${params.name}`,
      preview: prompt,
      durationMs: Date.now() - startedAt,
    });

    const sessionPath = await createChildSessionFile({
      cwd: mode.value.cwd,
      sessionId,
      parentSessionPath,
    });

    const childState: ChildBootstrapState = {
      sessionId,
      sessionPath,
      parentSessionId,
      parentSessionPath,
      name: params.name,
      prompt,
      mode: mode.value.modeName,
      autoExit: mode.value.autoExit,
      autoExitTimeoutMs: mode.value.autoExitTimeoutMs,
      handoff: params.handoff ?? false,
      tools: mode.value.tools,
      outputFormat: params.outputFormat,
      startedAt,
    };

    const provisionalState: RuntimeSubagent = {
      event: "started",
      sessionId,
      sessionPath,
      parentSessionId,
      parentSessionPath,
      name: params.name,
      mode: mode.value.modeName,
      modeLabel: mode.value.modeName,
      cwd: mode.value.cwd,
      paneId: "",
      task: params.task,
      handoff: params.handoff ?? false,
      autoExit: mode.value.autoExit,
      autoExitTimeoutMs: mode.value.autoExitTimeoutMs,
      autoExitTimeoutActive: false,
      status: "running",
      outputFormat: params.outputFormat,
      startedAt,
      updatedAt: startedAt,
    };

    const command = this.buildLaunchCommand(provisionalState, childState, prompt, {
      launchTarget: { kind: "session", sessionPath },
      tmuxTarget: mode.value.tmuxTarget,
      mode: params.mode?.trim() ? mode.value.modeName : undefined,
      model: mode.value.model,
      thinkingLevel: mode.value.thinkingLevel,
      systemPrompt: mode.value.systemPrompt,
      systemPromptMode: mode.value.systemPromptMode,
    });

    const pane = await this.adapter.createPane({
      cwd: mode.value.cwd,
      title: params.name,
      command,
      target: mode.value.tmuxTarget,
    });

    const state: RuntimeSubagent = {
      ...provisionalState,
      paneId: pane.paneId,
    };

    this.states.set(sessionId, state);
    this.activeSessionIds.add(sessionId);
    await this.hooks.persistState(state);
    this.ensurePolling();
    this.refreshWidget();
    return { state: this.toPublicState(state), prompt };
  }

  async resume(
    params: ResumeSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
    options: ResumeExecutionOptions = {},
  ): Promise<ResumeSubagentResult> {
    const errorAction = options.errorAction ?? "resume";
    const progressAction =
      options.progressAction ?? (errorAction === "message" ? "message" : "start");
    const existing = this.getStateOrThrow(errorAction, params.sessionId);

    const paneAlive = await this.hasLivePane(existing);
    if (paneAlive) {
      this.activeSessionIds.add(existing.sessionId);
      throw runtimeSubagentError(
        errorAction,
        `${existing.name} (${existing.sessionId}) already has a live tmux pane/window. Inspect that tmux output directly from the parent session or use subagent message instead.`,
      );
    }

    this.activeSessionIds.delete(existing.sessionId);

    const availability = await this.adapter.isAvailable();
    if (!availability) {
      throw runtimeSubagentError(
        errorAction,
        "tmux is not available in the current session. Run the parent pi session inside tmux before resuming a subagent.",
      );
    }

    const mode = await resolveSubagentMode(this.pi, ctx, {
      mode: params.mode ?? existing.mode,
      cwd: params.cwd ?? existing.cwd,
      autoExit: params.autoExit ?? existing.autoExit,
    });
    if (!mode.value) {
      throw new Error(mode.error);
    }

    await fs.access(existing.sessionPath);

    const parentSessionId = ctx.sessionManager.getSessionId();
    const parentSessionPath = ctx.sessionManager.getSessionFile();
    const resumedAt = Date.now();

    emitProgressUpdate(onUpdate, {
      action: progressAction,
      phase: "launch",
      statusText: `Launching ${existing.name}`,
      preview: params.task,
      durationMs: 0,
    });

    const childState: ChildBootstrapState = {
      sessionId: existing.sessionId,
      sessionPath: existing.sessionPath,
      parentSessionId,
      parentSessionPath,
      name: existing.name,
      prompt: params.task,
      mode: mode.value.modeName,
      autoExit: mode.value.autoExit,
      autoExitTimeoutMs: mode.value.autoExitTimeoutMs,
      handoff: false,
      tools: mode.value.tools,
      outputFormat: existing.outputFormat,
      startedAt: existing.startedAt,
    };

    const provisionalState: RuntimeSubagent = {
      ...existing,
      event: "resumed",
      parentSessionId,
      parentSessionPath,
      mode: mode.value.modeName,
      modeLabel: mode.value.modeName,
      cwd: mode.value.cwd,
      paneId: "",
      task: params.task,
      handoff: false,
      autoExit: mode.value.autoExit,
      autoExitTimeoutMs: mode.value.autoExitTimeoutMs,
      autoExitTimeoutActive:
        existing.autoExitTimeoutActive ?? isAutoExitTimeoutModeActive(existing.sessionId),
      status: "running",
      summary: undefined,
      structured: undefined,
      structuredError: undefined,
      exitCode: undefined,
      updatedAt: resumedAt,
      completedAt: undefined,
    };

    const command = this.buildLaunchCommand(provisionalState, childState, params.task, {
      launchTarget: existing.sessionPath
        ? { kind: "session", sessionPath: existing.sessionPath }
        : { kind: "continue" },
      tmuxTarget: mode.value.tmuxTarget,
      mode: params.mode?.trim() ? mode.value.modeName : undefined,
      model: mode.value.model,
      thinkingLevel: mode.value.thinkingLevel,
      systemPrompt: mode.value.systemPrompt,
      systemPromptMode: mode.value.systemPromptMode,
    });

    const pane = await this.adapter.createPane({
      cwd: mode.value.cwd,
      title: existing.name,
      command,
      target: mode.value.tmuxTarget,
    });

    const state: RuntimeSubagent = {
      ...provisionalState,
      paneId: pane.paneId,
    };

    this.states.set(state.sessionId, state);
    this.activeSessionIds.add(state.sessionId);
    await this.hooks.persistState(state);
    this.ensurePolling();
    this.refreshWidget();
    return { state: this.toPublicState(state), prompt: params.task };
  }

  async message(
    params: MessageSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
  ): Promise<MessageSubagentResult> {
    const { state, autoResumed, resumePrompt } = await this.resolveMessageTarget(
      params.sessionId,
      ctx,
      onUpdate,
    );
    const deliveredState = await this.deliverMessage(state, params, onUpdate);
    return {
      state: this.toPublicState(deliveredState),
      autoResumed,
      resumePrompt,
    };
  }

  private async resolveMessageTarget(
    sessionId: string,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
  ): Promise<{ state: RuntimeSubagent; autoResumed: boolean; resumePrompt?: string }> {
    const existing = this.getStateOrThrow("message", sessionId);

    if (await this.hasLivePane(existing)) {
      this.activeSessionIds.add(existing.sessionId);
      return { state: existing, autoResumed: false };
    }

    this.activeSessionIds.delete(existing.sessionId);
    const resumed = await this.resume(
      {
        sessionId: existing.sessionId,
        task: existing.task,
        mode: existing.mode,
        cwd: existing.cwd,
        autoExit: existing.autoExit,
      },
      ctx,
      onUpdate,
      { progressAction: "message", errorAction: "message" },
    );
    return {
      state: resumed.state,
      autoResumed: true,
      resumePrompt: resumed.prompt,
    };
  }

  private async deliverMessage(
    state: RuntimeSubagent,
    params: MessageSubagentParams,
    onUpdate?: AgentToolUpdateCallback<any>,
  ): Promise<RuntimeSubagent> {
    const startedAt = Date.now();

    emitProgressUpdate(onUpdate, {
      action: "message",
      phase: "message",
      statusText: `Sending ${params.delivery} to ${state.name}`,
      preview: params.message,
      delivery: params.delivery,
      durationMs: 0,
    });

    await this.hooks.persistMessage({
      sessionId: params.sessionId,
      message: params.message,
      delivery: params.delivery,
      createdAt: Date.now(),
      status: "pending",
    });

    try {
      await this.markParentInjectedInput(state.sessionId);
      await this.adapter.sendText(state.paneId, params.message, params.delivery);
      emitProgressUpdate(onUpdate, {
        action: "message",
        phase: "message",
        statusText: `Delivered ${params.delivery} to ${state.name}`,
        preview: params.message,
        delivery: params.delivery,
        durationMs: Date.now() - startedAt,
      });
      await this.hooks.persistMessage({
        sessionId: params.sessionId,
        message: params.message,
        delivery: params.delivery,
        createdAt: Date.now(),
        deliveredAt: Date.now(),
        status: "delivered",
      });

      const updatedState: RuntimeSubagent = {
        ...state,
        event: "updated",
        status: "running",
        autoExitDeadlineAt: undefined,
        autoExitTimeoutActive: state.autoExitTimeoutActive,
        updatedAt: Date.now(),
      };

      this.states.set(updatedState.sessionId, updatedState);
      await this.hooks.persistState(updatedState);
      this.refreshWidget();
      return updatedState;
    } catch (error) {
      await this.hooks.persistMessage({
        sessionId: params.sessionId,
        message: params.message,
        delivery: params.delivery,
        createdAt: Date.now(),
        status: "failed",
      });
      throw error;
    }
  }

  async cancel(params: CancelSubagentParams): Promise<RuntimeSubagent> {
    const state = this.getStateOrThrow("cancel", params.sessionId);
    if (!this.activeSessionIds.has(params.sessionId)) {
      throw runtimeSubagentError(
        "cancel",
        `${state.name} (${state.sessionId}) does not have a live tmux pane/window right now. Inspect subagent list or the tmux state first.`,
      );
    }

    await this.adapter.killPane(state.paneId);
    const cancelled: RuntimeSubagent = {
      ...state,
      event: "cancelled",
      status: "cancelled",
      autoExitDeadlineAt: undefined,
      updatedAt: Date.now(),
      completedAt: Date.now(),
    };

    this.states.set(cancelled.sessionId, cancelled);
    this.activeSessionIds.delete(cancelled.sessionId);
    await this.hooks.persistState(cancelled);
    this.stopPollingIfIdle();
    this.refreshWidget();
    this.hooks.emitStatusMessage({
      content: `Subagent ${state.name} (${state.sessionId}) was cancelled.`,
    });
    return this.toPublicState(cancelled);
  }

  private ensurePolling(): void {
    if (this.pollTimer || this.activeSessionIds.size === 0) {
      return;
    }

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, 2000);
    this.pollTimer.unref?.();
  }

  private ensureWidgetTimer(): void {
    if (!this.ctx?.hasUI) {
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

  private async finalizeInactiveSubagent(state: RuntimeSubagent): Promise<void> {
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

  private async markParentInjectedInput(sessionId: string): Promise<void> {
    const markerPath = getParentInjectedInputMarkerPath(sessionId);
    const payload = JSON.stringify({ expiresAt: Date.now() + SUBAGENT_PARENT_INPUT_GRACE_MS });

    await fs.mkdir(path.dirname(markerPath), { recursive: true }).catch(() => undefined);
    await fs.writeFile(markerPath, payload, "utf8").catch(() => undefined);
  }

  private stopPollingIfIdle(): void {
    if (this.activeSessionIds.size !== 0 || !this.pollTimer) {
      return;
    }

    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private refreshWidget(): void {
    if (!this.ctx?.hasUI) {
      this.ensureWidgetTimer();
      return;
    }

    const activeSubagents = Array.from(this.activeSessionIds.values())
      .map((sessionId) => this.states.get(sessionId))
      .filter((state): state is RuntimeSubagent => state !== undefined)
      .sort((left, right) => left.startedAt - right.startedAt);

    this.hooks.renderWidget(this.ctx, activeSubagents);
    this.ensureWidgetTimer();
  }

  private async syncLiveState(
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
