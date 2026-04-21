import fs from "node:fs/promises";
import type { AgentToolUpdateCallback, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  buildContextTransferPrompt,
  generateContextTransferSummary,
  getConversationMessages,
} from "../../extensions/session-launch-utils.js";
import { resolveSubagentMode } from "../modes.js";
import { createChildSessionFile } from "../persistence.js";
import type {
  ChildBootstrapState,
  ResumeSubagentParams,
  ResumeSubagentResult,
  RuntimeSubagent,
  StartSubagentParams,
} from "../types.js";
import {
  emitProgressUpdate,
  runtimeSubagentError,
  type LaunchTarget,
  type ResolvedModeValue,
  type ResumeExecutionOptions,
  SubagentRuntimeBase,
} from "./base.js";
import { buildResumeStateBundle } from "./state-bundles.js";

export abstract class SubagentRuntimeExecution extends SubagentRuntimeBase {
  async resume(
    params: ResumeSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    options: ResumeExecutionOptions = {},
  ): Promise<ResumeSubagentResult> {
    const prepared = await this.prepareResumeExecution(params, ctx, onUpdate, options);
    const stateBundle = this.buildResumeStateBundle(
      prepared.existing,
      prepared.mode,
      params.task,
      prepared.parentSessionId,
      prepared.parentSessionPath,
      prepared.resumedAt,
    );
    const state = await this.launchStateBundle({
      mode: prepared.mode,
      title: prepared.existing.name,
      prompt: params.task,
      childState: stateBundle.childState,
      provisionalState: stateBundle.provisionalState,
      launchTarget: prepared.existing.sessionPath
        ? { kind: "session", sessionPath: prepared.existing.sessionPath }
        : { kind: "continue" },
      modeOverride: params.mode,
    });
    return { state: this.toPublicState(state), prompt: params.task };
  }

  protected async prepareResumeExecution(
    params: ResumeSubagentParams,
    ctx: ExtensionContext,
    onUpdate: AgentToolUpdateCallback | undefined,
    options: ResumeExecutionOptions,
  ): Promise<{
    existing: RuntimeSubagent;
    mode: ResolvedModeValue;
    parentSessionId: string;
    parentSessionPath: string | undefined;
    resumedAt: number;
  }> {
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
    await this.requireAdapterAvailability(errorAction);
    const mode = await this.resolveModeValue(ctx, {
      mode: params.mode ?? existing.mode,
      cwd: params.cwd ?? existing.cwd,
      autoExit: params.autoExit ?? existing.autoExit,
    });
    await fs.access(existing.sessionPath);
    emitProgressUpdate(onUpdate, {
      action: progressAction,
      phase: "launch",
      statusText: `Launching ${existing.name}`,
      preview: params.task,
      durationMs: 0,
    });

    return {
      existing,
      mode,
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionPath: ctx.sessionManager.getSessionFile(),
      resumedAt: Date.now(),
    };
  }

  protected async requireAdapterAvailability(
    action: "start" | "resume" | "message",
  ): Promise<void> {
    const availability = await this.adapter.isAvailable();
    if (availability) {
      return;
    }

    const message =
      action === "start"
        ? "tmux is not available in the current session. Run the parent pi session inside tmux before starting a subagent."
        : "tmux is not available in the current session. Run the parent pi session inside tmux before resuming a subagent.";
    throw runtimeSubagentError(action, message);
  }

  protected async resolveModeValue(
    ctx: ExtensionContext,
    input: { mode?: string; cwd?: string; autoExit?: boolean },
  ): Promise<ResolvedModeValue> {
    const resolved = await resolveSubagentMode(this.pi, ctx, input);
    if (!resolved.value) {
      throw new Error(resolved.error);
    }

    return resolved.value;
  }

  protected async buildSpawnPrompt(
    params: StartSubagentParams,
    ctx: ExtensionContext,
    parentSessionPath: string | undefined,
    startedAt: number,
    onUpdate: AgentToolUpdateCallback | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (params.handoff !== true) {
      return params.task;
    }

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
    if (summary.error !== undefined && summary.error.length > 0) {
      throw new Error(summary.error);
    }
    if (summary.aborted === true || summary.summary === undefined || summary.summary.length === 0) {
      throw new Error("Cancelled");
    }

    return buildContextTransferPrompt(summary.summary, parentSessionPath);
  }

  protected buildSpawnStateBundle(
    params: StartSubagentParams,
    mode: ResolvedModeValue,
    prompt: string,
    parentSessionId: string,
    parentSessionPath: string | undefined,
    startedAt: number,
    sessionId: string,
  ): { childState: ChildBootstrapState; provisionalState: RuntimeSubagent } {
    const sessionPath = createChildSessionFile({ cwd: mode.cwd, sessionId, parentSessionPath });
    return {
      childState: {
        sessionId,
        sessionPath,
        parentSessionId,
        parentSessionPath,
        name: params.name,
        prompt,
        mode: mode.modeName,
        autoExit: mode.autoExit,
        autoExitTimeoutMs: mode.autoExitTimeoutMs,
        handoff: params.handoff ?? false,
        tools: mode.tools,
        outputFormat: params.outputFormat,
        startedAt,
      },
      provisionalState: {
        event: "started",
        sessionId,
        sessionPath,
        parentSessionId,
        parentSessionPath,
        name: params.name,
        mode: mode.modeName,
        modeLabel: mode.modeName,
        cwd: mode.cwd,
        paneId: "",
        task: params.task,
        handoff: params.handoff ?? false,
        autoExit: mode.autoExit,
        autoExitTimeoutMs: mode.autoExitTimeoutMs,
        autoExitTimeoutActive: false,
        status: "running",
        outputFormat: params.outputFormat,
        startedAt,
        updatedAt: startedAt,
      },
    };
  }

  protected buildResumeStateBundle(
    existing: RuntimeSubagent,
    mode: ResolvedModeValue,
    task: string,
    parentSessionId: string,
    parentSessionPath: string | undefined,
    resumedAt: number,
  ): { childState: ChildBootstrapState; provisionalState: RuntimeSubagent } {
    return buildResumeStateBundle({
      existing,
      mode,
      task,
      parentSessionId,
      parentSessionPath,
      resumedAt,
    });
  }

  protected async launchStateBundle(input: {
    mode: ResolvedModeValue;
    title: string;
    prompt: string;
    childState: ChildBootstrapState;
    provisionalState: RuntimeSubagent;
    launchTarget: LaunchTarget;
    modeOverride: string | undefined;
  }): Promise<RuntimeSubagent> {
    const command = this.buildLaunchCommand(
      input.provisionalState,
      input.childState,
      input.prompt,
      {
        launchTarget: input.launchTarget,
        tmuxTarget: input.mode.tmuxTarget,
        mode: (input.modeOverride?.trim().length ?? 0) > 0 ? input.mode.modeName : undefined,
        model: input.mode.model,
        thinkingLevel: input.mode.thinkingLevel,
        systemPrompt: input.mode.systemPrompt,
        systemPromptMode: input.mode.systemPromptMode,
      },
    );
    const pane = await this.adapter.createPane({
      cwd: input.mode.cwd,
      title: input.title,
      command,
      target: input.mode.tmuxTarget,
    });
    const state: RuntimeSubagent = { ...input.provisionalState, paneId: pane.paneId };
    this.states.set(state.sessionId, state);
    this.activeSessionIds.add(state.sessionId);
    await this.hooks.persistState(state);
    this.ensurePolling();
    this.refreshWidget();
    return state;
  }
}
