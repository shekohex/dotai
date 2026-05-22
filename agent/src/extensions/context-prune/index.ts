import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { registerContextPruneTool } from "./context-prune-tool.js";
import { registerCommands, setPruneStatusWidget } from "./commands.js";
import { PruneFrontierTracker } from "./frontier.js";
import {
  isAssistantMessage,
  isRecord,
  isToolCallContent,
  type ToolResultMessageWithUnknownDetails,
} from "./guards.js";
import { ToolCallIndexer } from "./indexer.js";
import {
  setContextPruneLastResult,
  setContextPruneRuntime,
  type FlushResult,
} from "./public-api.js";
import { registerQueryTool } from "./query-tool.js";
import { StatsAccumulator } from "./stats.js";
import {
  AGENTIC_AUTO_SYSTEM_PROMPT,
  CONTEXT_PRUNE_TOOL_NAME,
  CUSTOM_TYPE_FRONTIER,
  CUSTOM_TYPE_INDEX,
  CUSTOM_TYPE_STATS,
  CUSTOM_TYPE_SUMMARY,
  DEFAULT_CONFIG,
  type CapturedBatch,
  type ContextPruneConfig,
  type FlushOptions,
  type PruneFrontier,
  type SummarizeResult,
} from "./types.js";
import {
  annotateWithUnprunedCount,
  captureBatch,
  captureUnindexedBatchesFromSession,
  formatSummaryToolCallRefs,
  groupBatchesByMode,
  makeSummaryDetails,
  pruneMessages,
  summarizeBatch,
  summarizeBatches,
  countUnprunedToolCalls,
} from "./runtime-support.js";

interface SessionAppender {
  appendCustomEntry(customType: string, data?: unknown): string;
  appendCustomMessageEntry(
    customType: string,
    content: string,
    display: boolean,
    details?: unknown,
  ): string;
}

interface RuntimeState {
  currentConfig: { value: ContextPruneConfig };
  indexer: ToolCallIndexer;
  stats: StatsAccumulator;
  frontier: PruneFrontierTracker;
  pendingBatches: CapturedBatch[];
  pruneCallbacks: Set<(result: FlushResult) => void>;
  isFlushing: boolean;
}

interface FlushContext {
  batches: CapturedBatch[];
  results: (SummarizeResult | null)[];
  processedBatches: CapturedBatch[];
  oversizedBatches: CapturedBatch[];
  rawCharCount: number;
  summaryCharCount: number;
  toolCallCount: number;
}

interface BeforeAgentStartResult {
  systemPrompt?: string;
}

interface ContextResult {
  messages?: AgentMessage[];
}

export default function contextPruneExtension(pi: ExtensionAPI): void {
  const state = createRuntimeState();
  const flushPending = (ctx: ExtensionContext, options?: FlushOptions) =>
    flushPendingBatches(pi, state, ctx, options ?? {});
  registerPublicApi(state, flushPending);
  registerEvents(pi, state, flushPending);
  registerQueryTool(pi, state.indexer);
  registerContextPruneTool(pi, (ctx, options) =>
    flushPending(ctx, { delivery: "runtime", ...options }),
  );
  registerCommands(
    pi,
    state.currentConfig,
    flushPending,
    (ctx) => capturePendingBatches(state, ctx),
    () => {
      syncToolActivation(pi, state);
    },
    () => state.stats.getStats(),
    state.indexer,
  );
}

function createRuntimeState(): RuntimeState {
  return {
    currentConfig: { value: { ...DEFAULT_CONFIG, pruneOn: "every-turn" } },
    indexer: new ToolCallIndexer(),
    stats: new StatsAccumulator(),
    frontier: new PruneFrontierTracker(),
    pendingBatches: [],
    pruneCallbacks: new Set(),
    isFlushing: false,
  };
}

function registerPublicApi(
  state: RuntimeState,
  flushPending: (ctx: ExtensionContext, options?: FlushOptions) => Promise<FlushResult>,
): void {
  setContextPruneRuntime({
    getConfig: () => state.currentConfig.value,
    flush: (ctx, options) => flushPending(ctx, options),
    pendingBatchCount: () => state.pendingBatches.length,
    onPrune: (callback) => {
      state.pruneCallbacks.add(callback);
      return () => {
        state.pruneCallbacks.delete(callback);
      };
    },
  });
}

function registerEvents(
  pi: ExtensionAPI,
  state: RuntimeState,
  flushPending: (ctx: ExtensionContext, options?: FlushOptions) => Promise<FlushResult>,
): void {
  pi.on("session_start", (_event, ctx) => handleSessionStart(pi, state, ctx));
  pi.on("session_tree", (_event, ctx) => {
    restoreSessionState(state, ctx);
  });
  pi.on("turn_end", (event, ctx) => handleTurnEnd(state, event, ctx, flushPending));
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName === "context_tag" && shouldFlushOnContextTag(state)) {
      await flushPending(ctx, { delivery: "runtime" });
    }
  });
  pi.on("message_end", async (event, ctx) => {
    if (shouldFlushOnFinalMessage(state, event.message)) {
      await flushPending(ctx, { delivery: "session" });
    }
  });
  pi.on("agent_end", (_event, ctx) => {
    updatePendingStatus(state, ctx);
  });
  pi.on("context", (event): ContextResult | undefined => pruneContext(state, event.messages));
  pi.on("before_agent_start", (event): BeforeAgentStartResult | undefined =>
    agenticPrompt(state, event.systemPrompt),
  );
}

async function handleSessionStart(
  pi: ExtensionAPI,
  state: RuntimeState,
  ctx: ExtensionContext,
): Promise<void> {
  state.currentConfig.value = await loadConfig();
  restoreSessionState(state, ctx);
  setPruneStatusWidget(ctx, state.currentConfig.value, state.stats.getStats());
  syncToolActivation(pi, state);
  setPruneStatusWidget(ctx, state.currentConfig.value, state.stats.getStats());
}

function restoreSessionState(state: RuntimeState, ctx: ExtensionContext): void {
  state.indexer.reconstructFromSession(ctx);
  state.stats.reconstructFromSession(ctx);
  state.frontier.reconstructFromSession(ctx);
  state.pendingBatches.length = 0;
}

async function handleTurnEnd(
  state: RuntimeState,
  event: {
    message: AgentMessage;
    toolResults: ToolResultMessageWithUnknownDetails[];
    turnIndex: number;
  },
  ctx: ExtensionContext,
  flushPending: (ctx: ExtensionContext, options?: FlushOptions) => Promise<FlushResult>,
): Promise<void> {
  if (!state.currentConfig.value.enabled || event.toolResults.length === 0) return;
  const captured = captureBatch(event.message, event.toolResults, event.turnIndex, Date.now());
  const batch = trimBatchToPendingRange(state, {
    ...captured,
    toolCalls: captured.toolCalls.filter(
      (toolCall) => toolCall.toolName !== CONTEXT_PRUNE_TOOL_NAME,
    ),
  });
  if (batch === null) return;
  state.pendingBatches.push(batch);
  if (state.currentConfig.value.pruneOn === "every-turn") {
    await flushPending(ctx, { delivery: "session" });
    return;
  }
  updatePendingStatus(state, ctx);
}

function updatePendingStatus(state: RuntimeState, ctx: ExtensionContext): void {
  if (!state.currentConfig.value.enabled || state.pendingBatches.length === 0) return;
  if (state.currentConfig.value.showPruneStatusLine) {
    setPruneStatusWidget(
      ctx,
      state.currentConfig.value,
      `prune: ${state.pendingBatches.length} pending`,
    );
  }
}

function shouldFlushOnContextTag(state: RuntimeState): boolean {
  return (
    state.currentConfig.value.enabled && state.currentConfig.value.pruneOn === "on-context-tag"
  );
}

function shouldFlushOnFinalMessage(state: RuntimeState, message: AgentMessage): boolean {
  return (
    state.currentConfig.value.enabled &&
    state.currentConfig.value.pruneOn === "agent-message" &&
    isFinalAssistantMessage(message)
  );
}

function agenticPrompt(
  state: RuntimeState,
  systemPrompt: string | undefined,
): BeforeAgentStartResult | undefined {
  if (!state.currentConfig.value.enabled || state.currentConfig.value.pruneOn !== "agentic-auto")
    return undefined;
  return { systemPrompt: `${systemPrompt ?? ""}\n\n${AGENTIC_AUTO_SYSTEM_PROMPT}` };
}

function pruneContext(state: RuntimeState, messages: AgentMessage[]): ContextResult | undefined {
  if (!state.currentConfig.value.enabled) return undefined;
  let nextMessages = messages;
  let changed = false;
  if (state.indexer.getIndex().size > 0) {
    nextMessages = pruneMessages(nextMessages, state.indexer);
    changed = nextMessages !== messages;
  }
  if (
    state.currentConfig.value.pruneOn === "agentic-auto" &&
    state.currentConfig.value.remindUnprunedCount
  ) {
    const annotated = annotateIfNeeded(state, nextMessages);
    changed ||= annotated !== nextMessages;
    nextMessages = annotated;
  }
  return changed ? { messages: nextMessages } : undefined;
}

function annotateIfNeeded(state: RuntimeState, messages: AgentMessage[]): AgentMessage[] {
  const count = countUnprunedToolCalls(messages, state.indexer);
  return count > 0 ? annotateWithUnprunedCount(messages, count) : messages;
}

function capturePendingBatches(state: RuntimeState, ctx: ExtensionContext): CapturedBatch[] {
  return capturePendingBatchesWithMode(state, ctx, state.currentConfig.value.batchingMode);
}

function capturePendingBatchesWithMode(
  state: RuntimeState,
  ctx: ExtensionContext,
  batchingMode: ContextPruneConfig["batchingMode"],
): CapturedBatch[] {
  const sourceBatches = readPendingBatchesFromSession(state, ctx);
  const trimmed = sourceBatches
    .map((batch) => trimBatchToPendingRange(state, batch))
    .filter((batch): batch is CapturedBatch => batch !== null);
  return groupBatchesByMode(trimmed, batchingMode);
}

function readPendingBatchesFromSession(
  state: RuntimeState,
  ctx: ExtensionContext,
): CapturedBatch[] {
  try {
    return captureUnindexedBatchesFromSession(ctx.sessionManager.getBranch(), state.indexer, [
      CONTEXT_PRUNE_TOOL_NAME,
    ]);
  } catch {
    return state.pendingBatches.slice();
  }
}

function trimBatchToPendingRange(state: RuntimeState, batch: CapturedBatch): CapturedBatch | null {
  const frontier = state.frontier.get();
  const toolCalls = batch.toolCalls.filter(
    (toolCall) => !state.indexer.isSummarized(toolCall.toolCallId),
  );
  if (toolCalls.length === 0) return null;
  if (frontier === null || batch.turnIndex > frontier.lastAttemptedTurnIndex)
    return { ...batch, toolCalls };
  if (batch.turnIndex < frontier.lastAttemptedTurnIndex) return null;
  const frontierIndex = toolCalls.findIndex(
    (toolCall) => toolCall.toolCallId === frontier.lastAttemptedToolCallId,
  );
  const remaining = frontierIndex < 0 ? toolCalls : toolCalls.slice(frontierIndex + 1);
  return remaining.length === 0 ? null : { ...batch, toolCalls: remaining };
}

async function flushPendingBatches(
  pi: ExtensionAPI,
  state: RuntimeState,
  ctx: ExtensionContext,
  options: FlushOptions,
): Promise<FlushResult> {
  if (state.isFlushing) return { ok: false, reason: "already-flushing" };
  const batches =
    options.previewedBatches ??
    capturePendingBatchesWithMode(
      state,
      ctx,
      options.batchingMode ?? state.currentConfig.value.batchingMode,
    );
  if (batches.length === 0) return { ok: false, reason: "empty" };
  if (options.signal?.aborted === true) return { ok: false, reason: "aborted" };
  state.pendingBatches.length = 0;
  state.isFlushing = true;
  try {
    return await flushCapturedBatches(pi, state, ctx, batches, options);
  } catch (error) {
    state.pendingBatches.unshift(...batches);
    return handleFlushError(state, ctx, options, error);
  } finally {
    state.isFlushing = false;
  }
}

async function flushCapturedBatches(
  pi: ExtensionAPI,
  state: RuntimeState,
  ctx: ExtensionContext,
  batches: CapturedBatch[],
  options: FlushOptions,
): Promise<FlushResult> {
  const sessionAppender = resolveSessionAppender(ctx, options);
  if (options.delivery === "session" && sessionAppender === undefined) {
    state.pendingBatches.unshift(...batches);
    return {
      ok: false,
      reason: "failed",
      error: "session manager does not support appending entries",
    };
  }
  setPruneStatusWidget(ctx, state.currentConfig.value, "prune: summarizing…");
  const results = await summarizePendingBatches(state, ctx, batches, options);
  const flushContext = processSummaries(pi, state, batches, results, options, sessionAppender);
  if (flushContext.processedBatches.length === 0) return { ok: false, reason: "summarizer-failed" };
  persistFrontier(pi, state, flushContext, options, sessionAppender);
  setPruneStatusWidget(ctx, state.currentConfig.value, state.stats.getStats());
  const result = flushResult(flushContext);
  setContextPruneLastResult(result);
  notifyPruneCallbacks(state, result);
  return result;
}

async function summarizePendingBatches(
  state: RuntimeState,
  ctx: ExtensionContext,
  batches: CapturedBatch[],
  options: FlushOptions,
): Promise<(SummarizeResult | null)[]> {
  if (options.onProgress === undefined) {
    return summarizeBatches(batches, state.currentConfig.value, ctx, {
      onBatchTextProgress: options.onBatchTextProgress,
      signal: options.signal,
    });
  }
  const results: (SummarizeResult | null)[] = [];
  for (const [index, batch] of batches.entries()) {
    options.onProgress(index, batches.length, batch, "start");
    const result = await summarizeBatch(batch, state.currentConfig.value, ctx, {
      signal: options.signal,
      onTextProgress: (receivedChars) =>
        options.onBatchTextProgress?.(index, batches.length, batch, receivedChars),
    });
    results.push(result);
    options.onProgress(index, batches.length, batch, result === null ? "skipped" : "done");
  }
  return results;
}

function processSummaries(
  pi: ExtensionAPI,
  state: RuntimeState,
  batches: CapturedBatch[],
  results: (SummarizeResult | null)[],
  options: FlushOptions,
  sessionAppender: SessionAppender | undefined,
): FlushContext {
  const context = emptyFlushContext(batches, results);
  for (const [index, batch] of batches.entries()) {
    const result = results[index];
    if (result === null || result === undefined) break;
    processSummary(pi, state, context, batch, result, options, sessionAppender);
  }
  return context;
}

function processSummary(
  pi: ExtensionAPI,
  state: RuntimeState,
  context: FlushContext,
  batch: CapturedBatch,
  result: SummarizeResult,
  options: FlushOptions,
  sessionAppender: SessionAppender | undefined,
): void {
  const rawCharCount = batch.toolCalls.reduce(
    (sum, toolCall) => sum + toolCall.resultText.length,
    0,
  );
  const refs = state.indexer.allocateSummaryRefs(batch);
  const summaryText = result.summaryText + formatSummaryToolCallRefs(refs);
  state.stats.add(result.usage);
  context.rawCharCount += rawCharCount;
  context.summaryCharCount += summaryText.length;
  context.toolCallCount += batch.toolCalls.length;
  if (summaryText.length > rawCharCount) {
    context.oversizedBatches.push(batch);
  } else if (options.delivery === "session" && sessionAppender !== undefined) {
    sessionAppender.appendCustomMessageEntry(
      CUSTOM_TYPE_SUMMARY,
      summaryText,
      false,
      makeSummaryDetails(batch, refs),
    );
    state.indexer.registerSummaryRefs(refs);
    persistBatchIndex(state, batch, sessionAppender);
  } else {
    pi.sendMessage(
      {
        customType: CUSTOM_TYPE_SUMMARY,
        content: summaryText,
        display: false,
        details: makeSummaryDetails(batch, refs),
      },
      { deliverAs: "steer" },
    );
    state.indexer.registerSummaryRefs(refs);
    state.indexer.addBatch(batch, pi);
  }
  context.processedBatches.push(batch);
}

function emptyFlushContext(
  batches: CapturedBatch[],
  results: (SummarizeResult | null)[],
): FlushContext {
  return {
    batches,
    results,
    processedBatches: [],
    oversizedBatches: [],
    rawCharCount: 0,
    summaryCharCount: 0,
    toolCallCount: 0,
  };
}

function persistBatchIndex(
  state: RuntimeState,
  batch: CapturedBatch,
  sessionAppender: SessionAppender,
): void {
  const records = batch.toolCalls.map((toolCall) => ({
    ...toolCall,
    turnIndex: batch.turnIndex,
    timestamp: batch.timestamp,
  }));
  for (const record of records) state.indexer.getIndex().set(record.toolCallId, record);
  sessionAppender.appendCustomEntry(CUSTOM_TYPE_INDEX, { toolCalls: records });
}

function persistFrontier(
  pi: ExtensionAPI,
  state: RuntimeState,
  context: FlushContext,
  options: FlushOptions,
  sessionAppender: SessionAppender | undefined,
): void {
  const snapshot = frontierSnapshot(context);
  state.frontier.advance(snapshot);
  if (options.delivery === "session" && sessionAppender !== undefined) {
    sessionAppender.appendCustomEntry(CUSTOM_TYPE_FRONTIER, snapshot);
    sessionAppender.appendCustomEntry(CUSTOM_TYPE_STATS, state.stats.getStats());
    return;
  }
  state.frontier.persist(pi);
  state.stats.persist(pi);
}

function frontierSnapshot(context: FlushContext): PruneFrontier {
  const lastBatch = context.processedBatches.at(-1);
  const lastToolCall = lastBatch?.toolCalls.at(-1);
  if (lastBatch === undefined || lastToolCall === undefined)
    throw new Error("missing processed batch");
  return {
    lastAttemptedToolCallId: lastToolCall.toolCallId,
    lastAttemptedToolName: lastToolCall.toolName,
    lastAttemptedTurnIndex: lastBatch.turnIndex,
    lastAttemptedTimestamp: lastBatch.timestamp,
    attemptedBatchCount: context.processedBatches.length,
    attemptedToolCallCount: context.toolCallCount,
    rawCharCount: context.rawCharCount,
    summaryCharCount: context.summaryCharCount,
    outcome:
      context.oversizedBatches.length === context.processedBatches.length
        ? "skipped-oversized"
        : "summarized",
  };
}

function flushResult(context: FlushContext): FlushResult {
  return {
    ok: true,
    reason:
      context.oversizedBatches.length === context.processedBatches.length
        ? "skipped-oversized"
        : "flushed",
    batchCount: context.processedBatches.length,
    toolCallCount: context.toolCallCount,
    rawCharCount: context.rawCharCount,
    summaryCharCount: context.summaryCharCount,
  };
}

function notifyPruneCallbacks(state: RuntimeState, result: FlushResult): void {
  for (const callback of state.pruneCallbacks) {
    callback(result);
  }
}

function handleFlushError(
  state: RuntimeState,
  ctx: ExtensionContext,
  options: FlushOptions,
  error: unknown,
): FlushResult {
  setPruneStatusWidget(ctx, state.currentConfig.value, state.stats.getStats());
  if (options.signal?.aborted === true) return { ok: false, reason: "aborted" };
  const message = errorMessage(error);
  ctx.ui.notify(`pruner: summarization failed: ${message}`, "error");
  return { ok: false, reason: "failed", error: message };
}

function resolveSessionAppender(
  ctx: ExtensionContext,
  options: FlushOptions,
): SessionAppender | undefined {
  return options.delivery === "session" && isSessionAppender(ctx.sessionManager)
    ? ctx.sessionManager
    : undefined;
}

function isSessionAppender(value: unknown): value is SessionAppender {
  return (
    isRecord(value) &&
    typeof value.appendCustomEntry === "function" &&
    typeof value.appendCustomMessageEntry === "function"
  );
}

function isFinalAssistantMessage(message: AgentMessage): boolean {
  return isAssistantMessage(message) && !message.content.some(isToolCallContent);
}

function syncToolActivation(pi: ExtensionAPI, state: RuntimeState): void {
  const shouldActivate =
    state.currentConfig.value.enabled && state.currentConfig.value.pruneOn === "agentic-auto";
  const activeTools = pi.getActiveTools();
  if (shouldActivate && !activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
    pi.setActiveTools([...activeTools, CONTEXT_PRUNE_TOOL_NAME]);
  } else if (!shouldActivate && activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
    pi.setActiveTools(activeTools.filter((toolName) => toolName !== CONTEXT_PRUNE_TOOL_NAME));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
