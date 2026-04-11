import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  buildContextTransferPrompt,
  generateContextTransferSummary,
  getConversationMessages,
} from "../session-launch-utils.js";
import type { TmuxTarget } from "../../mode-utils.js";
import { resolveSubagentMode } from "./modes.js";
import type { MuxAdapter } from "./mux.js";
import { renderSubagentWidget } from "./render.js";
import {
  createChildSessionFile,
  getParentInjectedInputMarkerPath,
  readChildSessionOutcome,
  readChildSessionStatus,
  reduceRuntimeSubagents,
  SUBAGENT_PARENT_INPUT_GRACE_MS,
} from "./session.js";
import {
  SUBAGENT_MESSAGE_ENTRY,
  SUBAGENT_STATE_ENTRY,
  SUBAGENT_STATUS_MESSAGE,
  SUBAGENT_WIDGET_KEY,
  serializeSubagentMessageEntry,
  serializeSubagentStateEntry,
  type CancelSubagentParams,
  type ChildBootstrapState,
  type MessageSubagentParams,
  type ResumeSubagentParams,
  type ResumeSubagentResult,
  type RuntimeSubagent,
  type StartSubagentParams,
  type StartSubagentResult,
  type SubagentMessageEntry,
  type SubagentToolProgressDetails,
  type SubagentStateEntry,
} from "./types.js";

type LaunchCommandBuilder = (state: RuntimeSubagent, childState: ChildBootstrapState, prompt: string, options: {
  launchTarget?: {
    kind: "session";
    sessionPath: string;
  } | {
    kind: "continue";
  };
  tmuxTarget: TmuxTarget;
  mode?: string;
  model?: string;
  thinkingLevel?: string;
  systemPrompt?: string;
  systemPromptMode: "append" | "replace";
}) => string;

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

export class SubagentManager {
  private ctx?: ExtensionContext;
  private states = new Map<string, RuntimeSubagent>();
  private activeSessionIds = new Set<string>();
  private pollTimer?: NodeJS.Timeout;
  private restoring = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly adapter: MuxAdapter,
    private readonly buildLaunchCommand: LaunchCommandBuilder,
  ) { }

  setContext(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  list(): RuntimeSubagent[] {
    return Array.from(this.states.values()).sort((left, right) => left.startedAt - right.startedAt);
  }

  async restore(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    this.restoring = true;

    try {
      const restored = reduceRuntimeSubagents(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId());
      this.states.clear();
      this.activeSessionIds.clear();

      for (const state of restored.values()) {
        this.states.set(state.sessionId, state);

        if (isTerminalStatus(state.status)) {
          continue;
        }

        const paneAlive = await this.adapter.paneExists(state.paneId).catch(() => false);
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

  async start(
    params: StartSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
    signal?: AbortSignal,
  ): Promise<StartSubagentResult> {
    const availability = await this.adapter.isAvailable();
    if (!availability) {
      throw new Error("tmux is not available in the current session");
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
      mode: mode.value.modeName,
      autoExit: mode.value.autoExit,
      handoff: params.handoff ?? false,
      tools: mode.value.tools,
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
      status: "running",
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
    await this.persistState(state);
    this.ensurePolling();
    this.refreshWidget();
    return { state, prompt };
  }

  async resume(
    params: ResumeSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback<any>,
  ): Promise<ResumeSubagentResult> {
    const existing = this.states.get(params.sessionId);
    if (!existing) {
      throw new Error(`Unknown subagent ${params.sessionId}`);
    }

    const paneAlive = existing.paneId ? await this.adapter.paneExists(existing.paneId).catch(() => false) : false;
    if (paneAlive) {
      this.activeSessionIds.add(existing.sessionId);
      throw new Error(`Subagent ${existing.name} (${existing.sessionId}) is already active; use message instead`);
    }

    this.activeSessionIds.delete(existing.sessionId);

    const availability = await this.adapter.isAvailable();
    if (!availability) {
      throw new Error("tmux is not available in the current session");
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
      action: "resume",
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
      mode: mode.value.modeName,
      autoExit: mode.value.autoExit,
      handoff: false,
      tools: mode.value.tools,
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
      status: "running",
      summary: undefined,
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
    await this.persistState(state);
    this.ensurePolling();
    this.refreshWidget();
    return { state, prompt: params.task };
  }

  async message(params: MessageSubagentParams, onUpdate?: AgentToolUpdateCallback<any>): Promise<RuntimeSubagent> {
    const state = this.states.get(params.sessionId);
    if (!state) {
      throw new Error(`Unknown active subagent ${params.sessionId}`);
    }
    if (!this.activeSessionIds.has(params.sessionId)) {
      throw new Error(`Subagent ${state.name} (${state.sessionId}) is not active; use resume instead`);
    }

    const startedAt = Date.now();

    emitProgressUpdate(onUpdate, {
      action: "message",
      phase: "message",
      statusText: `Sending ${params.delivery} to ${state.name}`,
      preview: params.message,
      delivery: params.delivery,
      durationMs: 0,
    });

    await this.persistMessage({
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
      await this.persistMessage({
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
        updatedAt: Date.now(),
      };

      this.states.set(updatedState.sessionId, updatedState);
      await this.persistState(updatedState);
      this.refreshWidget();
      return updatedState;
    } catch (error) {
      await this.persistMessage({
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
    const state = this.states.get(params.sessionId);
    if (!state) {
      throw new Error(`Unknown active subagent ${params.sessionId}`);
    }
    if (!this.activeSessionIds.has(params.sessionId)) {
      throw new Error(`Subagent ${state.name} (${state.sessionId}) is not active`);
    }

    await this.adapter.killPane(state.paneId).catch(() => undefined);
    const cancelled: RuntimeSubagent = {
      ...state,
      event: "cancelled",
      status: "cancelled",
      updatedAt: Date.now(),
      completedAt: Date.now(),
    };

    this.states.set(cancelled.sessionId, cancelled);
    this.activeSessionIds.delete(cancelled.sessionId);
    await this.persistState(cancelled);
    this.stopPollingIfIdle();
    this.refreshWidget();
    this.pi.sendMessage({
      customType: SUBAGENT_STATUS_MESSAGE,
      content: `Subagent ${state.name} (${state.sessionId}) was cancelled.`,
      display: true,
    }, { deliverAs: "steer" });
    return cancelled;
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

      const alive = await this.adapter.paneExists(state.paneId).catch(() => false);
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
    const terminal: RuntimeSubagent = {
      ...state,
      event: outcome.failed ? "failed" : "completed",
      status: outcome.failed ? "failed" : "completed",
      summary: outcome.summary,
      updatedAt: now,
      completedAt: now,
    };

    this.states.set(terminal.sessionId, terminal);
    this.activeSessionIds.delete(terminal.sessionId);
    await this.persistState(terminal);
    this.stopPollingIfIdle();

    const messageText = terminal.status === "completed"
      ? `Subagent ${terminal.name} (${terminal.sessionId}) completed.\n\n${terminal.summary ?? "No summary available."}`
      : `Subagent ${terminal.name} (${terminal.sessionId}) failed.\n\n${terminal.summary ?? "No summary available."}`;

    this.pi.sendMessage({
      customType: SUBAGENT_STATUS_MESSAGE,
      content: messageText,
      display: true,
    }, { deliverAs: "steer", triggerTurn: true });
  }

  private async persistState(state: SubagentStateEntry): Promise<void> {
    this.pi.appendEntry(SUBAGENT_STATE_ENTRY, serializeSubagentStateEntry(state));
  }

  private async persistMessage(entry: SubagentMessageEntry): Promise<void> {
    this.pi.appendEntry(SUBAGENT_MESSAGE_ENTRY, serializeSubagentMessageEntry(entry));
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
      return;
    }

    const activeSubagents = Array.from(this.activeSessionIds.values())
      .map((sessionId) => this.states.get(sessionId))
      .filter((state): state is RuntimeSubagent => state !== undefined)
      .sort((left, right) => left.startedAt - right.startedAt);

    this.ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, renderSubagentWidget(activeSubagents), { placement: "belowEditor" });
  }

  private async syncLiveState(state: RuntimeSubagent, event: RuntimeSubagent["event"]): Promise<RuntimeSubagent> {
    const liveStatus = await readChildSessionStatus(state.sessionPath);
    const nextState: RuntimeSubagent = {
      ...state,
      event,
      status: liveStatus,
      updatedAt: Date.now(),
    };

    this.states.set(nextState.sessionId, nextState);
    if (nextState.status !== state.status || nextState.event !== state.event) {
      await this.persistState(nextState);
    }

    return nextState;
  }
}
