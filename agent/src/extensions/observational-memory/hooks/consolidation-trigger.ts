import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { runObserver } from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import {
  isRateLimitedStreamFailure,
  parseRetryAfterMs,
  WORKER_MODEL_COOLDOWN_MS,
  WorkerStreamError,
} from "../agents/stream-errors.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import {
  type ConsolidationPhase,
  modelKey,
  type ModelSkip,
  type ResolveResult,
  type Runtime,
} from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
  OM_OBSERVATIONS_DROPPED,
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  buildObservationsDroppedData,
  buildObservationsRecordedData,
  buildReflectionsRecordedData,
  earlierCoverageMarkerId,
  foldLedger,
  fullProjection,
  isSourceEntry,
  latestCoverageIndex,
  latestCoverageMarkerId,
  observationToSummaryLine,
  realTokensSinceAnchor,
  rawTokensSinceObservationCoverage,
  rawTokensSinceReflectionCoverage,
  reflectionToSummaryLine,
  type Entry,
  type Reflection,
  type V3MemoryCustomType,
} from "../session-ledger/index.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

type ConsolidationCtx = {
  cwd: string;
  hasUI: boolean;
  ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
  model: Model<Api> | undefined;
  modelRegistry: ModelRegistry;
  getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined;
  sessionManager: {
    getBranch: () => Entry[];
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  };
};

type StageOutcome = "continue" | "abort";

type ReflectorStageResult = {
  outcome: StageOutcome;
  sameRunReflections: Reflection[];
  effectiveReflectionCoverageId?: string;
};

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
  return entries.slice(index + 1).filter((entry) => isSourceEntry(entry));
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
  pi.appendEntry(customType, data);
}

function mergeReflections(existing: Reflection[], additional: Reflection[]): Reflection[] {
  const seen = new Set(existing.map((reflection) => reflection.id));
  const merged = [...existing];
  for (const reflection of additional) {
    if (seen.has(reflection.id)) continue;
    seen.add(reflection.id);
    merged.push(reflection);
  }
  return merged;
}

/**
 * Real current context tokens from the session (provider-reported usage, the same basis the footer
 * percentage uses). Falls back to undefined when the host pi lacks getContextUsage or the count is
 * unknown (e.g. right after a compaction, before the next valid assistant response).
 *
 * @param {ConsolidationCtx} ctx Consolidation context carrying getContextUsage.
 * @returns {number | undefined} Provider-reported context tokens when measurable.
 */
function realContextTokens(ctx: ConsolidationCtx): number | undefined {
  const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  const tokens = usage?.tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
}

/**
 * Decide whether a worker stage is due, preferring real provider-reported token deltas over raw
 * estimates.
 *
 * @param {Entry[]} entries Current branch entries.
 * @param {Runtime} runtime Om runtime carrying config.
 * @param {number | undefined} currentTokens Real context tokens when measurable.
 * @param {V3MemoryCustomType} customType Coverage anchor ledger type for the stage.
 * @param {(entries: Entry[]) => number} rawEstimateFn Fallback raw-token estimate function.
 * @param {number} threshold Stage due threshold in tokens.
 * @returns {boolean} Whether the stage has enough uncovered progress to run.
 */
function stageDue(
  entries: Entry[],
  runtime: Runtime,
  currentTokens: number | undefined,
  customType: V3MemoryCustomType,
  rawEstimateFn: (entries: Entry[]) => number,
  threshold: number,
): boolean {
  if (currentTokens !== undefined) {
    const real = realTokensSinceAnchor(entries, customType, currentTokens);
    if (real !== undefined) return real >= threshold;
  }
  // Real delta unmeasurable (no usage baseline, or accounting basis changed) or
  // old pi host without getContextUsage — fall back to the raw estimate, which
  // self-limits after coverage and cannot over-fire or starve.
  return rawEstimateFn(entries) >= threshold;
}

function anyStageDue(
  entries: Entry[],
  runtime: Runtime,
  currentTokens: number | undefined,
): boolean {
  return (
    stageDue(
      entries,
      runtime,
      currentTokens,
      OM_OBSERVATIONS_RECORDED,
      rawTokensSinceObservationCoverage,
      runtime.config.observeAfterTokens,
    ) ||
    stageDue(
      entries,
      runtime,
      currentTokens,
      OM_REFLECTIONS_RECORDED,
      rawTokensSinceReflectionCoverage,
      runtime.config.reflectAfterTokens,
    )
  );
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
  return runtime.config.showWorkerNotifications && ctx.hasUI;
}

/**
 * Build a stage-aware model resolver walking the runtime's candidate chain on every call.
 *
 * @param {Runtime} runtime Om runtime carrying config and resolve-failure notification state.
 * @param {ConsolidationCtx} ctx Consolidation context with model + registry access.
 * @returns {(
 *   stage: "observer" | "reflector" | "dropper",
 *   skip?: ModelSkip,
 * ) => Promise<ResolvedModel | undefined>}
 *   Resolver returning the resolved model, or undefined when unavailable.
 */
function makeModelResolver(
  runtime: Runtime,
  ctx: ConsolidationCtx,
): (
  stage: "observer" | "reflector" | "dropper",
  skip?: ModelSkip,
) => Promise<ResolvedModel | undefined> {
  return async (stage, skip): Promise<ResolvedModel | undefined> => {
    const resolved = await runtime.resolveModel(
      {
        model: ctx.model,
        modelRegistry: ctx.modelRegistry,
        hasUI: ctx.hasUI,
        ui: ctx.ui,
      },
      skip,
    );
    if (resolved.ok) {
      runtime.resolveFailureNotified = false;
      // Console Go (opencode.ai) rejects requests without x-opencode-session
      // (400 MissingSessionID). Mirror pi's own session headers on worker calls.
      const model = (resolved.model ?? {}) as { provider?: string; baseUrl?: string };
      if (
        model.provider === "opencode" ||
        model.provider === "opencode-go" ||
        (typeof model.baseUrl === "string" && model.baseUrl.includes("opencode.ai"))
      ) {
        const sessionId = ctx.sessionManager.getSessionId?.();
        if (sessionId !== undefined) {
          return {
            ...resolved,
            headers: {
              ...resolved.headers,
              "x-opencode-session": sessionId,
              "x-opencode-client": "pi",
            },
          };
        }
      }
      return resolved;
    }
    debugLog(`${stage}.model_unavailable`, { reason: resolved.reason });
    if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
      ctx.ui.notify(`Observational memory: ${stage} skipped — ${resolved.reason}`, "warning");
      runtime.resolveFailureNotified = true;
    }
    return undefined;
  };
}

/**
 * Run one worker stage, advancing through the configured fallback-model chain on terminal
 * API/stream failures.
 *
 * Rate-limit/overload failures additionally cool the failed model down (honoring a provider retry
 * hint when present), so later resolves — including after this run — skip it until the cooldown
 * expires and the primary model is tried first again. Other errors (quota, aborts, programming
 * errors) are rethrown unchanged. Returns undefined only when every candidate is exhausted (the
 * stage error has already been recorded by then).
 *
 * @template T Stage result type.
 * @param {Runtime} runtime Om runtime for cooldown state and notifications.
 * @param {ConsolidationCtx} ctx Consolidation context.
 * @param {(
 *   stage: "observer" | "reflector" | "dropper",
 *   skip?: ModelSkip,
 * ) => Promise<ResolvedModel | undefined>} resolveModel
 *   Stage-aware chain resolver.
 * @param {ConsolidationPhase} stage Worker stage label.
 * @param {(resolved: ResolvedModel) => Promise<T>} run Stage body for one resolved model.
 * @returns {Promise<T | undefined>} Stage result, or undefined when the chain is exhausted.
 */
async function runStageWithFallbacks<T>(
  runtime: Runtime,
  ctx: ConsolidationCtx,
  resolveModel: (
    stage: "observer" | "reflector" | "dropper",
    skip?: ModelSkip,
  ) => Promise<ResolvedModel | undefined>,
  stage: ConsolidationPhase,
  run: (resolved: ResolvedModel) => Promise<T>,
): Promise<T | undefined> {
  const failedKeys = new Set<string>();
  for (;;) {
    const resolved = await resolveModel(stage, failedKeys);
    if (resolved === undefined) return undefined;
    try {
      return await run(resolved);
    } catch (error) {
      if (!(error instanceof WorkerStreamError) || error.stopReason === "aborted") throw error;
      const failedKey = modelKey(resolved.model);
      failedKeys.add(failedKey);
      runtime.recordConsolidationStageError(ctx, stage, error);
      const failure = {
        stopReason: error.stopReason,
        errorMessage: error.workerErrorMessage,
      };
      if (isRateLimitedStreamFailure(failure)) {
        const cooldownMs = parseRetryAfterMs(error.workerErrorMessage) ?? WORKER_MODEL_COOLDOWN_MS;
        runtime.noteModelCooldown(resolved.model.provider, resolved.model.id, cooldownMs);
      }
      debugLog(`${stage}.model_fallback`, { failedKey, stopReason: error.stopReason });
      if (shouldNotifyWorker(runtime, ctx)) {
        ctx.ui?.notify(
          `Observational memory: ${stage} failed on ${failedKey} (${error.workerErrorMessage ?? error.stopReason}); trying next fallback`,
          "warning",
        );
      }
    }
  }
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
  const launch = (_event: unknown, ctx: ConsolidationCtx) => {
    maybeLaunchConsolidation(pi, runtime, ctx);
  };
  pi.on("agent_start", launch);
  pi.on("turn_end", launch);
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
  try {
    return {
      sessionId: ctx.sessionManager.getSessionId?.(),
      sessionFile: ctx.sessionManager.getSessionFile?.(),
    };
  } catch {
    return {};
  }
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
  runtime.ensureConfig(ctx.cwd);
  if (runtime.config.passive) return;
  if (runtime.consolidationInFlight) return;

  const entries: Entry[] = ctx.sessionManager.getBranch();
  if (!anyStageDue(entries, runtime, realContextTokens(ctx))) return;

  const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const consolidationCtx: ConsolidationCtx = {
    cwd: ctx.cwd,
    hasUI: ctx.hasUI,
    ui: ctx.ui,
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    getContextUsage: ctx.getContextUsage,
    sessionManager: ctx.sessionManager,
  };

  const sessionMetadata = debugSessionMetadata(ctx);
  void runtime.launchConsolidationTask(ctx, () =>
    withDebugLogContext(
      {
        enabled: runtime.config.debugLog,
        cwd: ctx.cwd,
        ...sessionMetadata,
        runId,
      },
      async () => {
        await runConsolidationPipeline(pi, runtime, consolidationCtx);
      },
    ),
  );
}

export async function runConsolidationPipeline(
  pi: ExtensionAPI,
  runtime: Runtime,
  ctx: ConsolidationCtx,
): Promise<void> {
  const resolveModel = makeModelResolver(runtime, ctx);

  runtime.consolidationPhase = "observer";
  try {
    const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel);
    if (observerOutcome === "abort") return;
  } catch (error) {
    debugLog("observer.error", {
      errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error),
    });
    return;
  }

  runtime.consolidationPhase = "reflector";
  let reflectorResult: ReflectorStageResult;
  try {
    reflectorResult = await runReflectorStage(pi, runtime, ctx, resolveModel);
    if (reflectorResult.outcome === "abort") return;
  } catch (error) {
    debugLog("reflector.error", {
      errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error),
    });
    return;
  }

  runtime.consolidationPhase = "dropper";
  try {
    await runDropperStage(
      pi,
      runtime,
      ctx,
      resolveModel,
      reflectorResult.sameRunReflections,
      reflectorResult.effectiveReflectionCoverageId,
    );
  } catch (error) {
    debugLog("dropper.error", {
      errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error),
    });
  }
}

async function runObserverStage(
  pi: ExtensionAPI,
  runtime: Runtime,
  ctx: ConsolidationCtx,
  resolveModel: (stage: ConsolidationPhase, skip?: ModelSkip) => Promise<ResolvedModel | undefined>,
): Promise<StageOutcome> {
  const entries: Entry[] = ctx.sessionManager.getBranch();
  const currentTokens = realContextTokens(ctx);
  const real =
    currentTokens === undefined
      ? undefined
      : realTokensSinceAnchor(entries, OM_OBSERVATIONS_RECORDED, currentTokens);
  // Fallback when no usage baseline / accounting basis changed.
  const tokens = real ?? rawTokensSinceObservationCoverage(entries);
  if (tokens < runtime.config.observeAfterTokens) return "continue";

  const sessionMetadata = debugSessionMetadata(ctx);
  const sessionIdentity = sessionMetadata.sessionId ?? sessionMetadata.sessionFile;
  const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);

  // Deliberate-empty backoff (#23): an intentional "nothing to record" verdict
  // must not re-fire the observer every turn over the same span. Retry only
  // after another observeAfterTokens worth of new source tokens arrives, and
  // drop the backoff as soon as coverage advances.
  const backoff = runtime.observerEmptyBackoff;
  if (backoff) {
    if (
      sessionIdentity !== backoff.sessionIdentity ||
      coverageId !== backoff.coverageId ||
      tokens >= backoff.tokensAtEmpty + runtime.config.observeAfterTokens
    ) {
      runtime.observerEmptyBackoff = undefined;
    } else {
      debugLog("observer.empty_backoff", {
        tokens,
        resumeAtTokens: backoff.tokensAtEmpty + runtime.config.observeAfterTokens,
      });
      return "continue";
    }
  }

  // Resolve the model before building the chunk: the default chunk cap
  // derives from the resolved model's context window.
  const resolved = await resolveModel("observer");
  if (!resolved) return "abort";

  const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
  const backlogEntries = sourceEntriesAfter(entries, lastCoverageIdx);

  // Budget the text that is actually sent to the observer, including source
  // labels and rendered message content. Complete entries are kept intact.
  // Only a first entry that cannot fit by itself is represented by a clearly
  // marked head/tail excerpt; the original ledger entry remains untouched.
  const contextWindow = (resolved.model as { contextWindow?: number }).contextWindow;
  const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
  const {
    text: chunk,
    sourceEntryIds,
    estimatedTokens: chunkTokens,
    truncatedSourceEntryIds,
  } = serializeSourceAddressedBranchEntries(backlogEntries, { maxTokens: maxChunkTokens });
  if (chunk.trim().length === 0 || sourceEntryIds.length === 0) return "continue";
  const coversUpToId = sourceEntryIds.at(-1);
  if (coversUpToId === undefined) return "continue";

  if (sourceEntryIds.length < backlogEntries.length || truncatedSourceEntryIds.length > 0) {
    debugLog("observer.chunk_capped", {
      maxChunkTokens,
      backlogEntries: backlogEntries.length,
      backlogTokens: tokens,
      chunkEntries: sourceEntryIds.length,
      chunkTokens,
      truncatedSourceEntryIds,
    });
  }

  const memory = fullProjection(entries);
  const priorReflections = memory.reflections.map(reflectionToSummaryLine);
  const priorObservations = memory.observations.map(observationToSummaryLine);

  if (shouldNotifyWorker(runtime, ctx))
    ctx.ui?.notify(
      `Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk`,
      "info",
    );
  debugLog("observer.start", {
    tokens,
    chunkTokens,
    coversUpToId,
    sourceEntryIds,
    sourceEntryCount: sourceEntryIds.length,
    priorReflections: priorReflections.length,
    priorObservations: priorObservations.length,
  });

  const observations = await runStageWithFallbacks(
    runtime,
    ctx,
    resolveModel,
    "observer",
    (candidate) =>
      runObserver({
        model: candidate.model,
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        env: resolved.env,
        priorReflections,
        priorObservations,
        chunk,
        allowedSourceEntryIds: sourceEntryIds,
        maxTurns: runtime.config.agentMaxTurns,
        maxOutputTokens: runtime.config.agentMaxTokens,
        thinkingLevel: candidate.thinking ?? "low",
        modelRegistry: ctx.modelRegistry,
      }),
  );
  if (observations === undefined) {
    // Chain exhausted (stream errors already recorded) — coverage stays put.
    return "abort";
  }
  if (observations === undefined || observations.length === 0) {
    // Deliberate empty: routine info, not a warning, and back off re-fires
    // over the same span (#23).
    debugLog("observer.empty", { coversUpToId });
    runtime.observerEmptyBackoff = { sessionIdentity, coverageId, tokensAtEmpty: tokens };
    if (shouldNotifyWorker(runtime, ctx))
      ctx.ui?.notify(
        "Observational memory: observer found nothing new in this chunk (coverage unchanged; will retry later)",
        "info",
      );
    return "continue";
  }
  runtime.observerEmptyBackoff = undefined;

  const data = buildObservationsRecordedData(observations, coversUpToId);
  if (!data) return "continue";
  debugLog("observer.records", {
    count: observations.length,
    observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
    coversUpToId,
  });
  appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
  debugLog("observer.appended", { count: observations.length, coversUpToId });
  if (shouldNotifyWorker(runtime, ctx))
    ctx.ui?.notify(
      `Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
      "info",
    );
  return "continue";
}

async function runReflectorStage(
  pi: ExtensionAPI,
  runtime: Runtime,
  ctx: ConsolidationCtx,
  resolveModel: (stage: ConsolidationPhase, skip?: ModelSkip) => Promise<ResolvedModel | undefined>,
): Promise<ReflectorStageResult> {
  const entries: Entry[] = ctx.sessionManager.getBranch();
  const currentTokens = realContextTokens(ctx);
  const real =
    currentTokens === undefined
      ? undefined
      : realTokensSinceAnchor(entries, OM_REFLECTIONS_RECORDED, currentTokens);
  // Fallback when no usage baseline / accounting basis changed.
  const reflectionTokens = real ?? rawTokensSinceReflectionCoverage(entries);
  if (reflectionTokens < runtime.config.reflectAfterTokens)
    return { outcome: "continue", sameRunReflections: [] };

  const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
  if (observationCoverageId === undefined) return { outcome: "continue", sameRunReflections: [] };

  if (shouldNotifyWorker(runtime, ctx))
    ctx.ui?.notify(
      `Observational memory: reflector running (~${reflectionTokens.toLocaleString()} tokens)`,
      "info",
    );
  const resolved = await resolveModel("reflector");
  if (!resolved) return { outcome: "abort", sameRunReflections: [] };

  const folded = foldLedger(entries);
  const reflections = await runStageWithFallbacks(
    runtime,
    ctx,
    resolveModel,
    "reflector",
    (candidate) =>
      runReflector({
        model: candidate.model,
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        env: resolved.env,
        reflections: folded.reflections,
        observations: folded.activeObservations,
        maxTurns: runtime.config.agentMaxTurns,
        maxOutputTokens: runtime.config.agentMaxTokens,
        thinkingLevel: candidate.thinking ?? "low",
        modelRegistry: ctx.modelRegistry,
      }),
  );
  if (!reflections) return { outcome: "continue", sameRunReflections: [] };

  const data = buildReflectionsRecordedData(reflections, observationCoverageId);
  if (!data) return { outcome: "continue", sameRunReflections: [] };
  appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
  return {
    outcome: "continue",
    sameRunReflections: reflections,
    effectiveReflectionCoverageId: data.coversUpToId,
  };
}

async function runDropperStage(
  pi: ExtensionAPI,
  runtime: Runtime,
  ctx: ConsolidationCtx,
  resolveModel: (stage: ConsolidationPhase, skip?: ModelSkip) => Promise<ResolvedModel | undefined>,
  sameRunReflections: Reflection[],
  sameRunReflectionCoverageId: string | undefined,
): Promise<StageOutcome> {
  if (sameRunReflectionCoverageId === undefined || sameRunReflections.length === 0) {
    debugLog("dropper.waiting_for_reflection", { sameRunReflections: sameRunReflections.length });
    return "continue";
  }

  const entries: Entry[] = ctx.sessionManager.getBranch();
  const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
  if (observationCoverageId === undefined) return "continue";

  const folded = foldLedger(entries);
  const metrics = observationPoolMetrics(
    folded.activeObservations,
    runtime.config.observationsPoolTargetTokens,
  );
  if (!metrics.ready) {
    debugLog("dropper.not_ready", {
      observationTokens: metrics.observationTokens,
      targetTokens: metrics.targetTokens,
      tokensOverTarget: metrics.tokensOverTarget,
      fullness: metrics.fullness,
      activeObservationCount: metrics.activeObservationCount,
      droppableCount: metrics.droppableCount,
      maxDropsAllowed: metrics.maxDropsAllowed,
    });
    return "continue";
  }
  debugLog("dropper.stage_start", {
    observationCoverageId,
    sameRunReflectionCoverageId,
    sameRunReflectionCount: sameRunReflections.length,
    activeObservationCount: metrics.activeObservationCount,
    observationTokens: metrics.observationTokens,
    targetTokens: metrics.targetTokens,
    tokensOverTarget: metrics.tokensOverTarget,
    fullness: metrics.fullness,
    maxDropsAllowed: metrics.maxDropsAllowed,
  });

  if (shouldNotifyWorker(runtime, ctx))
    ctx.ui?.notify(
      `Observational memory: dropper running after reflection — active observation pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens (${Math.round(metrics.fullness * 100).toLocaleString()}%)`,
      "info",
    );
  const resolved = await resolveModel("dropper");
  if (!resolved) return "abort";

  const reflectionsForDropper = mergeReflections(folded.reflections, sameRunReflections);
  const droppedIds = await runStageWithFallbacks(
    runtime,
    ctx,
    resolveModel,
    "dropper",
    (candidate) =>
      runDropper({
        model: candidate.model,
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        env: resolved.env,
        reflections: reflectionsForDropper,
        observations: folded.activeObservations,
        targetTokens: runtime.config.observationsPoolTargetTokens,
        maxTurns: runtime.config.agentMaxTurns,
        maxOutputTokens: runtime.config.agentMaxTokens,
        thinkingLevel: candidate.thinking ?? "low",
        modelRegistry: ctx.modelRegistry,
      }),
  );
  const coversUpToId = earlierCoverageMarkerId(
    entries,
    observationCoverageId,
    sameRunReflectionCoverageId,
  );
  const data =
    coversUpToId !== undefined && droppedIds !== undefined
      ? buildObservationsDroppedData(droppedIds, coversUpToId)
      : undefined;
  debugLog("dropper.append", {
    droppedIdsCount: droppedIds?.length ?? 0,
    coversUpToId,
    dataBuilt: data !== undefined,
    appended: data !== undefined,
  });
  if (data) appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
  return "continue";
}
