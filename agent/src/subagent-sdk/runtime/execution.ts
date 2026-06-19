import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  buildContextTransferPrompt,
  generateContextTransferSummary,
  getConversationMessages,
} from "../../extensions/session-launch-utils.js";
import { errorMessage } from "../../utils/error-message.js";
import { resolveSubagentMode } from "../modes.js";
import { createChildSessionFile } from "../persistence.js";
import { buildSubagentTaskPrompt } from "../prompt.js";
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

const PersistedSessionHeaderSchema = Type.Object(
  {
    type: Type.Literal("session"),
    id: Type.String(),
  },
  { additionalProperties: true },
);

type PersistedSessionHeader = Static<typeof PersistedSessionHeaderSchema>;

export abstract class SubagentRuntimeExecution extends SubagentRuntimeBase {
  async resume(
    params: ResumeSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    options: ResumeExecutionOptions = {},
  ): Promise<ResumeSubagentResult> {
    this.ctx = ctx;
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
      launchTarget:
        prepared.existing.sessionPath !== undefined && prepared.existing.sessionPath.length > 0
          ? { kind: "session", sessionPath: prepared.existing.sessionPath }
          : { kind: "continue" },
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
    const existing = await this.getExistingStateForResume(params, ctx, errorAction);
    const paneAlive = await this.hasLivePane(existing);
    if (paneAlive) {
      this.activeSessionIds.add(existing.sessionId);
      throw runtimeSubagentError(
        errorAction,
        `${existing.name} (${existing.sessionId}) already has a live mux target. Inspect that target from the parent session or use subagent message instead.`,
      );
    }

    this.activeSessionIds.delete(existing.sessionId);
    await this.requireAdapterAvailability(errorAction);
    if (existing.persisted === false || existing.sessionPath === undefined) {
      throw runtimeSubagentError(
        errorAction,
        `${existing.name} (${existing.sessionId}) is ephemeral (persisted: false) and cannot be resumed after its mux target exits. Start a new subagent instead.`,
      );
    }
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

  private async getExistingStateForResume(
    params: ResumeSubagentParams,
    ctx: ExtensionContext,
    errorAction: "resume" | "message",
  ): Promise<RuntimeSubagent> {
    const existing = this.states.get(params.sessionId);
    if (existing !== undefined) return existing;
    if (params.sessionPath === undefined || params.sessionPath.length === 0) {
      return this.getStateOrThrow(errorAction, params.sessionId);
    }
    const sessionFileId = await readSessionFileId(params.sessionPath, errorAction);
    if (sessionFileId !== params.sessionId) {
      return this.getStateOrThrow(errorAction, params.sessionId);
    }

    const now = Date.now();
    const hydrated: RuntimeSubagent = {
      event: "completed",
      sessionId: params.sessionId,
      sessionPath: params.sessionPath,
      persisted: params.persisted ?? true,
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionPath: ctx.sessionManager.getSessionFile(),
      name: params.name ?? "subagent",
      mode: params.mode,
      modeLabel: params.mode ?? "worker",
      cwd: params.cwd ?? ctx.cwd,
      paneId: "",
      task: params.task,
      tools: params.toolNames,
      handoff: false,
      autoExit: params.autoExit ?? true,
      completion: params.completion,
      status: "completed",
      outputFormat: params.outputFormat,
      startedAt: now,
      updatedAt: now,
      completedAt: now,
    };
    this.states.set(hydrated.sessionId, hydrated);
    return hydrated;
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
    input: { mode?: string; cwd?: string; autoExit?: boolean; model?: string },
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
      return buildSubagentTaskPrompt(params.task);
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

    return buildSubagentTaskPrompt(buildContextTransferPrompt(summary.summary, parentSessionPath));
  }

  protected buildSpawnStateBundle(
    params: StartSubagentParams,
    mode: ResolvedModeValue,
    prompt: string,
    parentSessionId: string,
    parentSessionPath: string | undefined,
    parentSessionPersisted: boolean,
    startedAt: number,
    sessionId: string,
  ): { childState: ChildBootstrapState; provisionalState: RuntimeSubagent } {
    const persisted = parentSessionPersisted ? (params.persisted ?? true) : false;
    const contextPrune = params.contextPrune ?? (persisted ? undefined : { enabled: false });
    const sessionPath = createChildSessionFile({
      cwd: mode.cwd,
      sessionId,
      parentSessionPath,
      persisted,
    });
    return {
      childState: {
        sessionId,
        sessionPath,
        persisted,
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
        contextPrune,
        startedAt,
      },
      provisionalState: {
        event: "started",
        sessionId,
        sessionPath,
        persisted,
        parentSessionId,
        parentSessionPath,
        name: params.name,
        mode: mode.modeName,
        modeLabel: mode.modeName,
        cwd: mode.cwd,
        paneId: "",
        task: params.task,
        tools: mode.tools,
        handoff: params.handoff ?? false,
        autoExit: mode.autoExit,
        autoExitTimeoutMs: mode.autoExitTimeoutMs,
        autoExitTimeoutActive: false,
        completion: params.completion,
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
  }): Promise<RuntimeSubagent> {
    const command = this.buildLaunchCommand(
      input.provisionalState,
      input.childState,
      input.prompt,
      {
        launchTarget: input.launchTarget,
        tmuxTarget: input.mode.tmuxTarget,
        model: input.mode.model,
        thinkingLevel: input.mode.thinkingLevel,
        systemPrompt: input.mode.systemPrompt,
        systemPromptMode: input.mode.systemPromptMode,
        modeName: input.mode.modeName,
      },
    );
    const pane = await this.adapter.createPane({
      cwd: input.mode.cwd,
      title: input.title,
      command,
      target: input.mode.tmuxTarget,
    });
    const state: RuntimeSubagent = {
      ...input.provisionalState,
      paneId: pane.paneId,
      muxBackend: pane.backend ?? this.adapter.backend,
    };
    this.states.set(state.sessionId, state);
    this.activeSessionIds.add(state.sessionId);
    await this.hooks.persistState(state);
    this.ensurePolling();
    this.refreshWidget();
    return state;
  }
}

async function readSessionFileId(
  sessionPath: string,
  errorAction: "resume" | "message",
): Promise<string | undefined> {
  let firstLine: string | undefined;
  try {
    firstLine = await readFirstLine(sessionPath);
  } catch (error) {
    throw runtimeSubagentError(
      errorAction,
      `sessionPath ${sessionPath} is not readable: ${errorMessage(error)}`,
    );
  }
  if (firstLine === undefined || firstLine.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (!Value.Check(PersistedSessionHeaderSchema, parsed)) return undefined;
    const header: PersistedSessionHeader = Value.Parse(PersistedSessionHeaderSchema, parsed);
    return header.id;
  } catch {
    return undefined;
  }
}

function readFirstLine(sessionPath: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(sessionPath, { encoding: "utf8", highWaterMark: 8192 });
    let line = "";
    let settled = false;
    const finish = (value?: string): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(value);
    };
    stream.on("data", (chunk) => {
      const text = String(chunk);
      const newlineIndex = text.indexOf("\n");
      if (newlineIndex === -1) {
        line += text;
        return;
      }
      finish(line + text.slice(0, newlineIndex));
    });
    stream.on("end", () => {
      finish(line.length > 0 ? line : undefined);
    });
    stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error);
    });
  });
}
