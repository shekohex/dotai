import { randomUUID } from "node:crypto";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createDefaultSubagentRuntimeHooks, type SubagentRuntimeHooks } from "../runtime-hooks.js";
import type { LaunchCommandBuilder } from "../launch.js";
import type { MuxAdapter } from "../mux.js";
import {
  cloneRuntimeSubagent,
  type CancelSubagentParams,
  type ChildBootstrapState,
  type MessageSubagentParams,
  type MessageSubagentResult,
  type ResumeSubagentParams,
  type ResumeSubagentResult,
  type RuntimeSubagent,
  type StartSubagentParams,
  type StartSubagentResult,
  type StructuredOutputError,
  type SubagentToolProgressDetails,
} from "../types.js";
import { reduceRuntimeSubagents } from "../persistence.js";
import type { resolveSubagentMode } from "../modes.js";

export function runtimeSubagentError(
  action: "start" | "resume" | "message" | "cancel",
  detail: string,
): Error {
  return new Error(`subagent ${action} failed: ${detail}`);
}

export function unknownSessionError(
  action: "message" | "cancel" | "resume",
  sessionId: string,
): Error {
  return runtimeSubagentError(
    action,
    `sessionId ${sessionId} was not found in this parent session. Use subagent list or a prior result to get the full UUID v4 sessionId.`,
  );
}

export function formatStructuredOutputError(
  error: StructuredOutputError | undefined,
): string | undefined {
  if (!error) {
    return undefined;
  }

  return `${error.message} (code: ${error.code}, attempts: ${error.attempts}, retryCount: ${error.retryCount})`;
}

export type ResumeExecutionOptions = {
  progressAction?: "message" | "start";
  errorAction?: "resume" | "message";
};

export type ResolvedModeValue = NonNullable<
  Awaited<ReturnType<typeof resolveSubagentMode>>["value"]
>;

export type LaunchTarget = { kind: "session"; sessionPath: string } | { kind: "continue" };

export function isTerminalStatus(status: RuntimeSubagent["status"]): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

export function emitProgressUpdate(
  onUpdate: AgentToolUpdateCallback | undefined,
  details: SubagentToolProgressDetails,
): void {
  const preview = details.preview?.trim();
  onUpdate?.({
    content: preview !== undefined && preview.length > 0 ? [{ type: "text", text: preview }] : [],
    details,
  });
}

export abstract class SubagentRuntimeBase {
  protected ctx?: ExtensionContext;
  protected states = new Map<string, RuntimeSubagent>();
  protected activeSessionIds = new Set<string>();
  protected pollTimer?: NodeJS.Timeout;
  protected widgetTimer?: NodeJS.Timeout;
  protected restoring = false;
  protected disposed = false;

  constructor(
    protected readonly pi: ExtensionAPI,
    protected readonly adapter: MuxAdapter,
    protected readonly buildLaunchCommand: LaunchCommandBuilder,
    protected readonly hooks: SubagentRuntimeHooks = createDefaultSubagentRuntimeHooks(pi),
  ) {}

  protected toPublicState(state: RuntimeSubagent): RuntimeSubagent {
    return cloneRuntimeSubagent(state);
  }

  dispose(): void {
    this.disposed = true;
    this.ctx = undefined;

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
      .toSorted((left, right) => left.startedAt - right.startedAt)
      .map((state) => this.toPublicState(state));
  }

  protected getStateOrThrow(
    action: "resume" | "message" | "cancel",
    sessionId: string,
  ): RuntimeSubagent {
    const state = this.states.get(sessionId);
    if (!state) {
      throw unknownSessionError(action, sessionId);
    }

    return state;
  }

  protected hasLivePane(state: RuntimeSubagent): Promise<boolean> {
    return state.paneId.length > 0
      ? this.adapter.paneExists(state.paneId).catch(() => false)
      : Promise.resolve(false);
  }

  async restore(ctx: ExtensionContext): Promise<void> {
    this.disposed = false;
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
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
  ): Promise<StartSubagentResult> {
    await this.requireAdapterAvailability("start");
    const mode = await this.resolveModeValue(ctx, {
      mode: params.mode,
      cwd: params.cwd,
      autoExit: params.autoExit,
    });
    const spawnContext = this.createSpawnContext(ctx);
    const prompt = await this.buildSpawnPrompt(
      params,
      ctx,
      spawnContext.parentSessionPath,
      spawnContext.startedAt,
      onUpdate,
      signal,
    );
    emitProgressUpdate(onUpdate, {
      action: "start",
      phase: "launch",
      statusText: `Launching ${params.name}`,
      preview: prompt,
      durationMs: Date.now() - spawnContext.startedAt,
    });
    const stateBundle = this.buildSpawnStateBundle(
      params,
      mode,
      prompt,
      spawnContext.parentSessionId,
      spawnContext.parentSessionPath,
      spawnContext.startedAt,
      spawnContext.sessionId,
    );
    const state = await this.launchStateBundle({
      mode,
      title: params.name,
      prompt,
      childState: stateBundle.childState,
      provisionalState: stateBundle.provisionalState,
      launchTarget: { kind: "session", sessionPath: stateBundle.childState.sessionPath },
      modeOverride: params.mode,
    });
    return { state: this.toPublicState(state), prompt };
  }

  protected createSpawnContext(ctx: ExtensionContext): {
    startedAt: number;
    parentSessionId: string;
    parentSessionPath: string | undefined;
    sessionId: string;
  } {
    return {
      startedAt: Date.now(),
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionPath: ctx.sessionManager.getSessionFile(),
      sessionId: randomUUID(),
    };
  }

  abstract resume(
    params: ResumeSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    options?: ResumeExecutionOptions,
  ): Promise<ResumeSubagentResult>;
  abstract message(
    params: MessageSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<MessageSubagentResult>;
  abstract cancel(params: CancelSubagentParams): Promise<RuntimeSubagent>;

  protected abstract requireAdapterAvailability(
    action: "start" | "resume" | "message",
  ): Promise<void>;
  protected abstract resolveModeValue(
    ctx: ExtensionContext,
    input: { mode?: string; cwd?: string; autoExit?: boolean },
  ): Promise<ResolvedModeValue>;
  protected abstract buildSpawnPrompt(
    params: StartSubagentParams,
    ctx: ExtensionContext,
    parentSessionPath: string | undefined,
    startedAt: number,
    onUpdate: AgentToolUpdateCallback | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string>;
  protected abstract buildSpawnStateBundle(
    params: StartSubagentParams,
    mode: ResolvedModeValue,
    prompt: string,
    parentSessionId: string,
    parentSessionPath: string | undefined,
    startedAt: number,
    sessionId: string,
  ): { childState: ChildBootstrapState; provisionalState: RuntimeSubagent };
  protected abstract launchStateBundle(input: {
    mode: ResolvedModeValue;
    title: string;
    prompt: string;
    childState: ChildBootstrapState;
    provisionalState: RuntimeSubagent;
    launchTarget: LaunchTarget;
    modeOverride: string | undefined;
  }): Promise<RuntimeSubagent>;
  protected abstract ensurePolling(): void;
  protected abstract refreshWidget(): void;
  protected abstract syncLiveState(
    state: RuntimeSubagent,
    event: RuntimeSubagent["event"],
  ): Promise<RuntimeSubagent>;
  protected abstract finalizeInactiveSubagent(state: RuntimeSubagent): Promise<void>;
}
