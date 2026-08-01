import { randomUUID } from "node:crypto";

import {
  createAgentSession,
  getAgentDir,
  SessionManager,
  type AgentToolUpdateCallback,
  type CreateAgentSessionResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  buildContextTransferPrompt,
  generateContextTransferSummary,
  getConversationMessages,
} from "../extensions/session-launch-utils.js";
import { errorMessage } from "../utils/error-message.js";
import { SubagentRuntimeEventBus } from "./events.js";
import { resolveSubagentMode, type ResolvedSubagentMode } from "./modes.js";
import { buildSubagentTaskPrompt } from "./prompt.js";
import { createLiteSessionResources } from "./lite-session-resources.js";
import {
  isTerminalSubagentStatus,
  renderLiteRuntimeWidget,
  resolveLiteRuntimeModel,
} from "./lite-runtime-ui.js";
import { buildLiteResumePrompt } from "./lite-resume-prompt.js";
import { buildInterruptedLiteState } from "./lite-interrupt.js";
import { forwardLiteChildEvent } from "./lite-events.js";
import {
  assertLiteSessionPathAccessible,
  createLiteSessionManager,
} from "./lite-session-manager.js";
import {
  buildStructuredError,
  buildStructuredOutputRetryPrompt,
  getStructuredRetryCount,
} from "./lite-structured-output.js";
import { createDefaultSubagentRuntimeHooks, type SubagentRuntimeHooks } from "./runtime-hooks.js";
import type { ResumeExecutionOptions } from "./runtime/base.js";
import {
  cloneRuntimeSubagent,
  type CancelSubagentParams,
  type MessageSubagentParams,
  type MessageSubagentResult,
  type ResumeSubagentParams,
  type ResumeSubagentResult,
  type RuntimeSubagent,
  type InterruptSubagentParams,
  type StartSubagentParams,
  type StartSubagentResult,
  type TokenUsage,
} from "./types.js";
import { toSubagentStatusDetails } from "./status.js";

type LiteAgentSession = CreateAgentSessionResult["session"];

export type LiteRuntimeOptions = {
  kind: "lite";
  agentDir?: string;
  hooks?: SubagentRuntimeHooks;
  createAgentSession?: typeof createAgentSession;
};

const DEFAULT_LITE_RUNTIME_OPTIONS: LiteRuntimeOptions = { kind: "lite" };

type LiteSessionState = {
  session: LiteAgentSession;
  sessionPath?: string;
  unsubscribe: () => void;
  structuredCapture: { value?: unknown };
  abortController: AbortController;
};

function toTokenUsage(stats: ReturnType<LiteAgentSession["getSessionStats"]>): TokenUsage {
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    total: stats.tokens.total,
    cost: stats.cost,
  };
}

function resolveCompletionDelivery(state: RuntimeSubagent) {
  return state.completion === false
    ? ({ enabled: false, deliverAs: "steer", triggerTurn: false } as const)
    : {
        enabled: true,
        deliverAs: state.completion?.deliverAs ?? "steer",
        triggerTurn: state.completion?.triggerTurn ?? true,
      };
}

function buildCompletionStatusContent(state: RuntimeSubagent, suffix: string): string {
  if (state.status === "completed") {
    return `Subagent ${state.name} (${state.sessionId}) completed.\n\n${state.summary ?? "No summary available."}${suffix}`;
  }
  if (state.status === "cancelled")
    return `Subagent ${state.name} (${state.sessionId}) was cancelled.`;
  return `Subagent ${state.name} (${state.sessionId}) failed.\n\n${state.structuredError?.message ?? state.summary ?? "No summary available."}${suffix}`;
}

export class LiteRuntime {
  private states = new Map<string, RuntimeSubagent>();
  private sessions = new Map<string, LiteSessionState>();
  private runGenerations = new Map<string, number>();
  private disposed = false;
  private lastCtx: ExtensionContext | undefined;
  private readonly eventBus = new SubagentRuntimeEventBus();
  private readonly hooks: SubagentRuntimeHooks;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: LiteRuntimeOptions = DEFAULT_LITE_RUNTIME_OPTIONS,
  ) {
    this.hooks = options.hooks ?? createDefaultSubagentRuntimeHooks(pi);
  }

  listStates(): RuntimeSubagent[] {
    return Array.from(this.states.values())
      .toSorted((left, right) => left.startedAt - right.startedAt)
      .map((state) => cloneRuntimeSubagent(state));
  }

  readonly onEvent = (
    listener: Parameters<SubagentRuntimeEventBus["subscribe"]>[0],
  ): (() => void) => this.eventBus.subscribe(listener);
  readonly onChildEvent = (
    listener: Parameters<SubagentRuntimeEventBus["subscribeChildEvent"]>[0],
  ): (() => void) => this.eventBus.subscribeChildEvent(listener);
  readonly onParentMessage = (
    listener: Parameters<SubagentRuntimeEventBus["subscribeParentMessage"]>[0],
  ): (() => void) => this.eventBus.subscribeParentMessage(listener);

  renderWidget(ctx: ExtensionContext | undefined = this.lastCtx): void {
    this.lastCtx = renderLiteRuntimeWidget(this.hooks, ctx, this.listStates());
  }

  restore(ctx?: ExtensionContext): Promise<void> {
    this.renderWidget(ctx);
    this.eventBus.emitChangedStates(this.listStates());
    return Promise.resolve();
  }

  async spawn(
    params: StartSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
  ): Promise<StartSubagentResult> {
    this.lastCtx = ctx;
    this.disposed = false;
    const startedAt = Date.now();
    const resolved = await resolveSubagentMode(this.pi, ctx, {
      mode: params.mode,
      cwd: params.cwd,
      autoExit: params.autoExit,
      model: params.model,
    });
    if (!resolved.value) {
      throw new Error(resolved.error);
    }

    const sessionId = randomUUID();
    const prompt = await this.buildPrompt(params, ctx, startedAt, onUpdate, signal);
    const parentSessionPath = ctx.sessionManager.getSessionFile();
    const { sessionManager, sessionPath, persisted } = createLiteSessionManager({
      cwd: resolved.value.cwd,
      sessionId,
      parentSessionPath,
      persisted: params.persisted,
    });
    const state = this.createInitialState(
      params,
      ctx,
      resolved.value,
      sessionId,
      startedAt,
      persisted,
      sessionPath,
    );
    const structuredCapture: { value?: unknown } = {};
    const model = resolveLiteRuntimeModel(ctx, resolved.value, params.model);
    const agentDir = this.options.agentDir ?? getAgentDir();
    const { customTools, resourceLoader, sessionTools, settingsManager } =
      await createLiteSessionResources({
        cwd: resolved.value.cwd,
        mode: resolved.value,
        params,
        structuredCapture,
        sessionManager,
        agentDir,
        sendParentMessage: (message) => {
          this.eventBus.emitParentMessage({ sessionId, message });
        },
      });
    const stateWithTools = { ...state, tools: sessionTools };
    const { session } = await (this.options.createAgentSession ?? createAgentSession)({
      cwd: resolved.value.cwd,
      agentDir,
      settingsManager,
      resourceLoader,
      sessionManager,
      tools: sessionTools,
      customTools,
      ...(model === undefined ? {} : { model }),
      ...(resolved.value.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: resolved.value.thinkingLevel }),
    });
    const abortController = new AbortController();
    const unsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(sessionId, event, onUpdate);
    });
    this.sessions.set(sessionId, {
      session,
      sessionPath,
      unsubscribe,
      structuredCapture,
      abortController,
    });
    this.states.set(sessionId, stateWithTools);
    await this.hooks.persistState(stateWithTools);
    this.renderWidget(ctx);
    this.eventBus.emitChangedStates(this.listStates());
    signal?.addEventListener(
      "abort",
      () => {
        void this.cancel({ sessionId });
      },
      { once: true },
    );
    void this.runSession(sessionId, prompt);

    return { state: cloneRuntimeSubagent(stateWithTools), prompt };
  }

  async resume(
    params: ResumeSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    options: ResumeExecutionOptions = {},
  ): Promise<ResumeSubagentResult> {
    this.lastCtx = ctx;
    if (params.sessionPath === undefined || params.sessionPath.length === 0) {
      throw new Error("subagent resume failed: lite resume requires a persisted sessionPath.");
    }
    await assertLiteSessionPathAccessible(params.sessionPath);
    this.disposed = false;
    const startedAt = Date.now();
    const resolved = await resolveSubagentMode(this.pi, ctx, {
      mode: params.mode,
      cwd: params.cwd,
      autoExit: params.autoExit,
      model: params.model,
    });
    if (!resolved.value) {
      throw new Error(resolved.error);
    }

    const resumeStateParams = { ...params, name: params.name ?? params.sessionId };
    const state = this.createInitialState(
      resumeStateParams,
      ctx,
      resolved.value,
      params.sessionId,
      startedAt,
      true,
      params.sessionPath,
    );
    const structuredCapture: { value?: unknown } = {};
    const model = resolveLiteRuntimeModel(ctx, resolved.value, params.model);
    const agentDir = this.options.agentDir ?? getAgentDir();
    const sessionManager = SessionManager.open(params.sessionPath, undefined, resolved.value.cwd);
    const { customTools, resourceLoader, sessionTools, settingsManager } =
      await createLiteSessionResources({
        cwd: resolved.value.cwd,
        mode: resolved.value,
        params,
        structuredCapture,
        sessionManager,
        agentDir,
        sendParentMessage: (message) => {
          this.eventBus.emitParentMessage({ sessionId: params.sessionId, message });
        },
      });
    const stateWithTools = { ...state, tools: sessionTools };
    const { session } = await (this.options.createAgentSession ?? createAgentSession)({
      cwd: resolved.value.cwd,
      agentDir,
      settingsManager,
      resourceLoader,
      sessionManager,
      tools: sessionTools,
      customTools,
      ...(model === undefined ? {} : { model }),
      ...(resolved.value.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: resolved.value.thinkingLevel }),
    });
    const abortController = new AbortController();
    const unsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(params.sessionId, event, onUpdate);
    });
    this.sessions.set(params.sessionId, {
      session,
      sessionPath: params.sessionPath,
      unsubscribe,
      structuredCapture,
      abortController,
    });
    this.states.set(params.sessionId, stateWithTools);
    await this.hooks.persistState(stateWithTools);
    this.renderWidget(ctx);
    this.eventBus.emitChangedStates(this.listStates());
    options.signal?.addEventListener(
      "abort",
      () => {
        void this.cancel({ sessionId: params.sessionId });
      },
      { once: true },
    );
    void this.continueSession(params.sessionId, buildLiteResumePrompt(params.task));
    return { state: cloneRuntimeSubagent(stateWithTools), prompt: params.task };
  }

  async message(
    params: MessageSubagentParams,
    _ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<MessageSubagentResult> {
    this.lastCtx = _ctx;
    const state = this.states.get(params.sessionId);
    const live = this.sessions.get(params.sessionId);
    if (!state || !live) {
      throw new Error(
        `subagent message failed: lite sessionId ${params.sessionId} is not live. Start a new subagent instead.`,
      );
    }
    if (isTerminalSubagentStatus(state.status)) {
      throw new Error(
        `subagent message failed: lite sessionId ${params.sessionId} already completed. Start a new subagent instead.`,
      );
    }

    onUpdate?.({
      content: [{ type: "text", text: params.message }],
      details: {
        action: "message",
        phase: "message",
        statusText: `Sending ${params.delivery} to ${state.name}`,
        preview: params.message,
        delivery: params.delivery,
        durationMs: 0,
      },
    });
    if (state.status === "idle") {
      void this.continueSession(params.sessionId, params.message);
    } else if (params.delivery === "followUp") {
      await live.session.followUp(params.message);
    } else {
      await live.session.steer(params.message);
    }

    const updated: RuntimeSubagent = {
      ...state,
      event: "updated",
      status: "running",
      updatedAt: Date.now(),
    };
    this.states.set(params.sessionId, updated);
    await this.hooks.persistMessage({
      sessionId: params.sessionId,
      message: params.message,
      delivery: params.delivery,
      createdAt: Date.now(),
      deliveredAt: Date.now(),
      status: "delivered",
    });
    await this.hooks.persistState(updated);
    this.renderWidget(_ctx);
    this.eventBus.emitChangedStates(this.listStates());
    return { state: cloneRuntimeSubagent(updated), autoResumed: false };
  }

  async cancel(params: CancelSubagentParams): Promise<RuntimeSubagent> {
    const state = this.states.get(params.sessionId);
    if (!state) {
      throw new Error(`subagent cancel failed: unknown lite sessionId ${params.sessionId}.`);
    }
    const live = this.sessions.get(params.sessionId);
    if (isTerminalSubagentStatus(state.status)) {
      return cloneRuntimeSubagent(state);
    }
    if (!live) {
      throw new Error(
        `subagent cancel failed: lite sessionId ${params.sessionId} is not live. Start a new subagent instead.`,
      );
    }
    live?.abortController.abort();
    await live?.session.abort().catch(() => {});
    this.disposeSession(params.sessionId);
    const now = Date.now();
    const cancelled: RuntimeSubagent = {
      ...state,
      event: "cancelled",
      status: "cancelled",
      activity: {
        sessionId: state.sessionId,
        kind: "cancelled",
        label: "cancelled",
        startedAt: state.startedAt,
        updatedAt: now,
        done: true,
      },
      updatedAt: now,
      completedAt: now,
    };
    this.states.set(cancelled.sessionId, cancelled);
    await this.hooks.persistState(cancelled);
    this.renderWidget();
    this.eventBus.emitChangedStates(this.listStates());
    this.emitCompletionStatus(cancelled);
    return cloneRuntimeSubagent(cancelled);
  }

  async interrupt(params: InterruptSubagentParams): Promise<RuntimeSubagent> {
    const state = this.states.get(params.sessionId);
    const live = this.sessions.get(params.sessionId);
    if (!state || !live || isTerminalSubagentStatus(state.status)) {
      throw new Error(
        `subagent interrupt failed: lite sessionId ${params.sessionId} is not running.`,
      );
    }
    this.nextRunGeneration(params.sessionId);
    await live.session.abort().catch(() => {});
    const interrupted = buildInterruptedLiteState(state, Date.now());
    this.states.set(params.sessionId, interrupted);
    await this.hooks.persistState(interrupted);
    this.renderWidget();
    this.eventBus.emitChangedStates(this.listStates());
    return cloneRuntimeSubagent(interrupted);
  }

  captureOutput(sessionId: string): { text: string } {
    const state = this.states.get(sessionId);
    if (!state) throw new Error(`Unknown subagent sessionId: ${sessionId}`);

    return { text: state.summary ?? "" };
  }

  dispose(): void {
    this.disposed = true;
    for (const sessionId of this.sessions.keys()) this.disposeSession(sessionId);
    this.hooks.dispose?.();
  }

  private async buildPrompt(
    params: StartSubagentParams,
    ctx: ExtensionContext,
    startedAt: number,
    onUpdate: AgentToolUpdateCallback | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (params.handoff !== true) {
      return buildSubagentTaskPrompt(params.task);
    }

    onUpdate?.({
      content: [],
      details: {
        action: "start",
        phase: "handoff",
        statusText: `Preparing handoff for ${params.name}`,
        durationMs: 0,
      },
    });
    const summary = await generateContextTransferSummary(
      ctx,
      params.task,
      getConversationMessages(ctx),
      signal,
      ({ summary: partialSummary }) => {
        onUpdate?.({
          content: partialSummary.trim().length > 0 ? [{ type: "text", text: partialSummary }] : [],
          details: {
            action: "start",
            phase: "handoff",
            statusText: `Generating handoff prompt for ${params.name}`,
            preview: partialSummary,
            durationMs: Date.now() - startedAt,
          },
        });
      },
    );
    if (summary.error !== undefined && summary.error.length > 0) {
      throw new Error(summary.error);
    }
    if (summary.aborted === true || summary.summary === undefined || summary.summary.length === 0) {
      throw new Error("Cancelled");
    }

    return buildSubagentTaskPrompt(
      buildContextTransferPrompt(summary.summary, ctx.sessionManager.getSessionFile()),
    );
  }

  private createInitialState(
    params: StartSubagentParams,
    ctx: ExtensionContext,
    mode: ResolvedSubagentMode,
    sessionId: string,
    startedAt: number,
    persisted: boolean,
    sessionPath: string | undefined,
  ): RuntimeSubagent {
    return {
      event: "started",
      sessionId,
      sessionPath,
      persisted,
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionPath: ctx.sessionManager.getSessionFile(),
      name: params.name,
      mode: mode.modeName,
      modeLabel: mode.modeName,
      cwd: mode.cwd,
      paneId: `lite:${sessionId}`,
      muxBackend: "lite",
      task: params.task,
      tools: mode.tools,
      handoff: params.handoff ?? false,
      autoExit: true,
      completion: params.completion,
      status: "running",
      outputFormat: params.outputFormat,
      startedAt,
      updatedAt: startedAt,
    };
  }

  private handleSessionEvent(
    sessionId: string,
    event: Parameters<LiteAgentSession["subscribe"]>[0] extends (event: infer TEvent) => void
      ? TEvent
      : never,
    onUpdate?: AgentToolUpdateCallback,
  ): void {
    forwardLiteChildEvent(this.eventBus, sessionId, event);
    const existing = this.states.get(sessionId);
    if (!existing) {
      return;
    }
    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent;
      const delta = "delta" in assistantEvent ? assistantEvent.delta : undefined;
      if (typeof delta === "string" && delta.length > 0) {
        onUpdate?.({ content: [{ type: "text", text: delta }], details: { event: event.type } });
      }
    }
    if (event.type === "tool_execution_start") {
      this.states.set(sessionId, {
        ...existing,
        event: "updated",
        activity: {
          sessionId,
          kind: "tool",
          label: event.toolName,
          toolName: event.toolName,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          done: false,
        },
        updatedAt: Date.now(),
      });
      this.renderWidget();
      this.eventBus.emitChangedStates(this.listStates());
    }
  }
  private async runSession(sessionId: string, prompt: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    const state = this.states.get(sessionId);
    if (!live || !state) {
      return;
    }
    const generation = this.nextRunGeneration(sessionId);

    try {
      await this.runPromptWithStructuredRetries(sessionId, prompt, live);
      if (!this.isCurrentRunGeneration(sessionId, generation)) return;
      if (this.disposed || live.abortController.signal.aborted) {
        return;
      }
      await this.completeSession(sessionId, live);
    } catch (error) {
      if (!this.isCurrentRunGeneration(sessionId, generation)) return;
      if (this.disposed || live.abortController.signal.aborted) {
        return;
      }
      await this.failSession(sessionId, error);
    }
  }

  private async continueSession(sessionId: string, prompt: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (!live) {
      return;
    }
    const generation = this.nextRunGeneration(sessionId);

    try {
      await this.runPromptWithStructuredRetries(sessionId, prompt, live);
      if (!this.isCurrentRunGeneration(sessionId, generation)) return;
      if (this.disposed || live.abortController.signal.aborted) {
        return;
      }
      await this.completeSession(sessionId, live);
    } catch (error) {
      if (!this.isCurrentRunGeneration(sessionId, generation)) return;
      if (this.disposed || live.abortController.signal.aborted) {
        return;
      }
      await this.failSession(sessionId, error);
    }
  }

  private async runPromptWithStructuredRetries(
    sessionId: string,
    prompt: string,
    live: LiteSessionState,
  ): Promise<void> {
    await live.session.prompt(prompt, { source: "extension" });
    let attempts = 0;
    while (this.shouldRetryStructuredOutput(sessionId, live, attempts)) {
      attempts += 1;
      const state = this.states.get(sessionId);
      if (!state) {
        return;
      }
      await live.session.prompt(buildStructuredOutputRetryPrompt(state, attempts), {
        source: "extension",
      });
    }
  }

  private shouldRetryStructuredOutput(
    sessionId: string,
    live: LiteSessionState,
    attempts: number,
  ): boolean {
    if (this.disposed || live.abortController.signal.aborted) {
      return false;
    }
    if (live.structuredCapture.value !== undefined) {
      return false;
    }
    const state = this.states.get(sessionId);
    if (state?.outputFormat?.type !== "json_schema") {
      return false;
    }
    return attempts < getStructuredRetryCount(state.outputFormat);
  }

  private async completeSession(sessionId: string, live: LiteSessionState): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) {
      return;
    }
    const now = Date.now();
    const summary = live.session.getLastAssistantText();
    const structuredMissing =
      state.outputFormat?.type === "json_schema" && live.structuredCapture.value === undefined;
    const tokenUsage = toTokenUsage(live.session.getSessionStats());
    this.disposeSession(sessionId);
    const terminal: RuntimeSubagent = {
      ...state,
      event: structuredMissing ? "failed" : "completed",
      status: structuredMissing ? "failed" : "completed",
      activity: {
        sessionId,
        kind: structuredMissing ? "failed" : "completed",
        label: structuredMissing ? "failed" : "done",
        detail: summary,
        startedAt: state.startedAt,
        updatedAt: now,
        done: true,
      },
      summary,
      structured: live.structuredCapture.value,
      structuredError: structuredMissing
        ? buildStructuredError(
            "missing_tool_call",
            "Subagent completed without structured output. StructuredOutput tool may have been unavailable or not called.",
            state.outputFormat,
          )
        : undefined,
      tokenUsage,
      updatedAt: now,
      completedAt: now,
    };
    this.states.set(sessionId, terminal);
    await this.hooks.persistState(terminal);
    this.renderWidget();
    this.eventBus.emitChangedStates(this.listStates());
    this.emitCompletionStatus(terminal);
  }

  private async failSession(sessionId: string, error: unknown): Promise<void> {
    const state = this.states.get(sessionId);
    const live = this.sessions.get(sessionId);
    if (!state) {
      return;
    }
    const now = Date.now();
    const tokenUsage =
      live === undefined ? undefined : toTokenUsage(live.session.getSessionStats());
    this.disposeSession(sessionId);
    const failed: RuntimeSubagent = {
      ...state,
      event: "failed",
      status: "failed",
      activity: {
        sessionId,
        kind: "failed",
        label: "failed",
        detail: errorMessage(error),
        startedAt: state.startedAt,
        updatedAt: now,
        done: true,
      },
      summary: errorMessage(error),
      structuredError:
        state.outputFormat?.type === "json_schema"
          ? buildStructuredError("aborted", errorMessage(error), state.outputFormat)
          : undefined,
      tokenUsage,
      updatedAt: now,
      completedAt: now,
    };
    this.states.set(sessionId, failed);
    await this.hooks.persistState(failed);
    this.renderWidget();
    this.eventBus.emitChangedStates(this.listStates());
    this.emitCompletionStatus(failed);
  }

  private emitCompletionStatus(state: RuntimeSubagent): void {
    const delivery = resolveCompletionDelivery(state);
    if (!delivery.enabled || !isTerminalSubagentStatus(state.status)) return;
    const suffix =
      state.persisted === false
        ? "\n\nThis subagent was ephemeral (persisted: false) and cannot be messaged or resumed. Start a new subagent if you need to run it again."
        : "";
    const content = buildCompletionStatusContent(state, suffix);
    this.hooks.emitStatusMessage({
      content,
      details: toSubagentStatusDetails(state)!,
      deliverAs: delivery.deliverAs,
      triggerTurn: delivery.triggerTurn,
    });
  }

  private nextRunGeneration(sessionId: string): number {
    const generation = (this.runGenerations.get(sessionId) ?? 0) + 1;
    this.runGenerations.set(sessionId, generation);
    return generation;
  }

  private isCurrentRunGeneration(sessionId: string, generation: number): boolean {
    return this.runGenerations.get(sessionId) === generation;
  }

  private disposeSession(sessionId: string): void {
    const live = this.sessions.get(sessionId);
    if (!live) return;

    live.unsubscribe();
    live.session.dispose();
    this.sessions.delete(sessionId);
    this.runGenerations.delete(sessionId);
  }
}
