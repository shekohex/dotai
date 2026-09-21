import {
  agentLoop,
  type AgentContext,
  type AgentLoopConfig,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  Message,
  Model,
  ModelThinkingLevel,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { drainWorkerStream, WorkerStreamError } from "../stream-errors.js";
import {
  resolveWorkerStreamSimple,
  type StreamableModelRegistry,
  type WorkerStreamSimple,
} from "../worker-stream.js";
import {
  reflectionToSummaryLine,
  type Observation,
  type Reflection,
} from "../../session-ledger/index.js";
import { DROPPER_SYSTEM } from "./prompts.js";

/**
 * Log the dropper's "not over target" outcome: the pool never crossed the threshold, so the agent
 * loop does not run at all.
 *
 * @param {Observation[]} observations Active observations at dropper start.
 * @param {ReturnType<typeof reflectionCoverageMap>} coverageById Coverage tier per observation.
 * @param {number} maxDropsAllowed Computed drop budget (always <= 0 here).
 * @returns {void}
 */
function logDropperNotOverTarget(
  observations: Observation[],
  coverageById: ReturnType<typeof reflectionCoverageMap>,
  maxDropsAllowed: number,
): void {
  debugLog("dropper.result", {
    reason: "not_over_target",
    toolCallCount: 0,
    rawRequestedIdsCount: 0,
    acceptedCandidateCount: 0,
    selectedDropsCount: 0,
    selectedDropTokens: 0,
    selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(
      [],
      observations,
      coverageById,
    ),
    maxDropsAllowed,
  });
}

/**
 * Explain why the dropper selected what it did, for the debug log.
 *
 * @param {number} droppedCount Selected drop-candidate count.
 * @param {number} toolCallCount Tool-call round trips the loop used.
 * @param {number} requestedCount Drop ids the dropper requested.
 * @returns {string} Reason label.
 */
function selectDropReason(
  droppedCount: number,
  toolCallCount: number,
  requestedCount: number,
): string {
  if (droppedCount > 0) return "selected_nonempty";
  if (toolCallCount === 0) return "no_tool_call";
  if (requestedCount === 0) return "all_filtered";
  return "selected_empty";
}

/**
 * Thrown when the dropper's agent loop ends with an API/stream failure (`stopReason`
 * `"error"`/`"aborted"`) without selecting any drops. Mirrors the observer's #32 semantics: a hard
 * failure must not masquerade as a deliberate empty result.
 */
export class DropperStreamError extends WorkerStreamError {
  constructor(stopReason: string, errorMessage?: string) {
    super("dropper", stopReason, errorMessage);
    this.name = "DropperStreamError";
  }
}
import {
  REFLECTION_COVERAGE_DROP_RANK,
  coverageTierForObservation,
  reflectionCoverageMap,
  summarizeCoverageByRelevance,
  summarizeCoverageByRelevanceForIds,
  observationToDropperLine,
} from "./coverage.js";
import { observationPoolMetrics } from "./pool.js";
export { maxDropCountForPool, observationPoolFullness, observationPoolMetrics } from "./pool.js";
export type { ObservationPoolMetrics } from "./pool.js";
export {
  REFLECTION_COVERAGE_TIERS,
  coverageTierForObservation,
  emptyCoverageSummaryByRelevance,
  observationToDropperLine,
  reflectionCoverageMap,
  reflectionCoverageTierForCount,
  reflectionSupportCounts,
  summarizeCoverageByRelevance,
  summarizeCoverageByRelevanceForIds,
  summarizeCoverageTransitionsByRelevance,
} from "./coverage.js";
export type {
  CoverageSummaryByRelevance,
  CoverageTransitionSummaryByRelevance,
  ReflectionCoverageTier,
} from "./coverage.js";

interface RunDropperArgs {
  model: Model<Api>;
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
  reflections: Reflection[];
  observations: Observation[];
  targetTokens: number;
  signal?: AbortSignal;
  agentLoop?: typeof agentLoop;
  maxTurns?: number;
  /** Maximum output tokens for the loop (defaults to {@link AGENT_LOOP_MAX_TOKENS}). */
  maxOutputTokens?: number;
  thinkingLevel?: ModelThinkingLevel;
  modelRegistry?: StreamableModelRegistry;
  streamSimple?: WorkerStreamSimple;
}

const RELEVANCE_DROP_RANK: Record<Observation["relevance"], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const DropObservationsSchema = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  reason: Type.Optional(Type.String()),
});

type DropObservationsArgs = Static<typeof DropObservationsSchema>;

function joinOrEmpty(items: string[]): string {
  return items.length > 0 ? items.join("\n") : "(none yet)";
}

function relevanceCounts(
  observations: readonly Observation[],
): Record<Observation["relevance"], number> {
  return observations.reduce<Record<Observation["relevance"], number>>(
    (counts, observation) => {
      counts[observation.relevance]++;
      return counts;
    },
    { low: 0, medium: 0, high: 0, critical: 0 },
  );
}

export function normalizeDropObservationIds(
  ids: readonly string[] | undefined,
  observations: readonly Observation[],
): string[] | undefined {
  if (!ids || ids.length === 0) return undefined;
  const allowed = new Map(observations.map((observation) => [observation.id, observation]));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const observation = allowed.get(id);
    if (!observation) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result.length > 0 ? result : undefined;
}

function timestampRank(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function selectDropCandidates(
  ids: readonly string[],
  observations: readonly Observation[],
  maxDrops: number,
  reflections: readonly Reflection[] = [],
): string[] {
  if (maxDrops <= 0 || ids.length === 0) return [];

  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const coverageById = reflectionCoverageMap(observations, reflections);
  const firstProposalIndex = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!firstProposalIndex.has(id)) firstProposalIndex.set(id, i);
  }

  return Array.from(firstProposalIndex.entries())
    .map(([id, index]) => ({ id, index, observation: byId.get(id) }))
    .filter(
      (candidate): candidate is { id: string; index: number; observation: Observation } =>
        candidate.observation !== undefined,
    )
    .toSorted((a, b) => {
      const coverageDelta =
        REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(a.observation, coverageById)] -
        REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(b.observation, coverageById)];
      const relevanceDelta =
        RELEVANCE_DROP_RANK[a.observation.relevance] - RELEVANCE_DROP_RANK[b.observation.relevance];
      const ageDelta =
        timestampRank(a.observation.timestamp) - timestampRank(b.observation.timestamp);
      return coverageDelta || relevanceDelta || ageDelta || a.index - b.index;
    })
    .slice(0, maxDrops)
    .map((candidate) => candidate.id);
}

/** Counters collected while the model proposes drop candidates. */
type DropperToolStats = {
  toolCalls: number;
  rawRequested: number;
  missing: number;
  critical: number;
  duplicatesInRequest: number;
  duplicatesInRun: number;
};

/**
 * Build the drop_observations tool bound to this run's candidate state.
 *
 * @param {Set<string>} proposed Observation ids already proposed this run.
 * @param {string[]} proposedDropIds Accepted candidate ids, in request order.
 * @param {Map<string, Observation>} allowed Active observations the model may drop.
 * @param {number} maxDropsAllowed Hard upper bound on drops this run.
 * @param {DropperToolStats} stats Run counters for diagnostics.
 * @returns {AgentTool<typeof DropObservationsSchema>} The drop_observations tool.
 */
function makeDropObservationsTool(
  proposed: Set<string>,
  proposedDropIds: string[],
  allowed: Map<string, Observation>,
  maxDropsAllowed: number,
  stats: DropperToolStats,
): AgentTool<typeof DropObservationsSchema> {
  return {
    name: "drop_observations",
    label: "Drop observations",
    description: "Propose active observation ids that are safe to remove from compacted memory.",
    parameters: DropObservationsSchema,
    execute: (_id, params: DropObservationsArgs) => {
      stats.toolCalls++;
      stats.rawRequested += params.ids.length;
      const seenInRequest = new Set<string>();
      let added = 0;
      for (const id of params.ids) {
        const observation = allowed.get(id);
        if (observation === undefined) {
          stats.missing++;
          continue;
        }
        if (seenInRequest.has(id)) {
          stats.duplicatesInRequest++;
          continue;
        }
        seenInRequest.add(id);
        if (proposed.has(id)) {
          stats.duplicatesInRun++;
          continue;
        }
        proposed.add(id);
        proposedDropIds.push(id);
        if (observation.relevance === "critical") stats.critical++;
        added++;
      }
      debugLog("dropper.tool_call", {
        toolCallCount: stats.toolCalls,
        rawRequestedIdsCount: params.ids.length,
        acceptedIdsCount: added,
        missingIdsCount: stats.missing,
        criticalCandidateIdsCount: stats.critical,
        duplicateInRequestCount: stats.duplicatesInRequest,
        duplicateInRunCount: stats.duplicatesInRun,
        totalCandidates: proposedDropIds.length,
        maxDropsAllowed,
      });
      return Promise.resolve({
        content: [
          {
            type: "text",
            text: `Queued ${added} drop candidate${added === 1 ? "" : "s"}. Candidates this run: ${proposedDropIds.length}. Maximum drops allowed: ${maxDropsAllowed}.`,
          },
        ],
        details: { added, totalCandidates: proposedDropIds.length, maxDropsAllowed },
      });
    },
  };
}

export async function runDropper(args: RunDropperArgs): Promise<string[] | undefined> {
  const { model, apiKey, headers, env, reflections, observations, targetTokens, signal } = args;
  if (observations.length === 0) return undefined;

  const metrics = observationPoolMetrics(observations, targetTokens);
  const { observationTokens, fullness, tokensOverTarget, maxDropsAllowed } = metrics;
  const coverageById = reflectionCoverageMap(observations, reflections);
  const coverageSummaryByRelevance = summarizeCoverageByRelevance(observations, coverageById);
  debugLog("dropper.agent_start", {
    activeObservationCount: observations.length,
    reflectionCount: reflections.length,
    observationTokens,
    targetTokens,
    tokensOverTarget,
    fullness,
    maxDropsAllowed,
    relevanceCounts: relevanceCounts(observations),
    coverageSummaryByRelevance,
  });
  if (maxDropsAllowed <= 0) {
    logDropperNotOverTarget(observations, coverageById, maxDropsAllowed);
    return undefined;
  }

  const proposedDropIds: string[] = [];
  const proposed = new Set<string>();
  const allowed = new Map(observations.map((observation) => [observation.id, observation]));
  const stats: DropperToolStats = {
    toolCalls: 0,
    rawRequested: 0,
    missing: 0,
    critical: 0,
    duplicatesInRequest: 0,
    duplicatesInRun: 0,
  };
  const dropObservations = makeDropObservationsTool(
    proposed,
    proposedDropIds,
    allowed,
    maxDropsAllowed,
    stats,
  );

  const fullnessPercent = Math.round(fullness * 100);
  const userText = `CURRENT REFLECTIONS:\n${joinOrEmpty(reflections.map((reflection) => reflectionToSummaryLine(reflection)))}\n\nCURRENT OBSERVATIONS:\n${joinOrEmpty(observations.map((observation) => observationToDropperLine(observation, coverageTierForObservation(observation, coverageById))))}\n\nActive observation pool: ~${observationTokens.toLocaleString()} tokens; target: ~${targetTokens.toLocaleString()} tokens; fullness against target: ~${fullnessPercent.toLocaleString()}%; over target by ~${tokensOverTarget.toLocaleString()} tokens.\nMaximum drops allowed this run: ${maxDropsAllowed.toLocaleString()} observation${maxDropsAllowed === 1 ? "" : "s"}. This maximum is sized to move the active pool toward the target if every proposed drop is clearly safe.\nThis maximum is a hard upper bound, not a target. Drop fewer or none if fewer observations are clearly safe.`;
  const prompts: Message[] = [
    { role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
  ];
  // pi 0.86 carries the system prompt as a leading system message, not context.systemPrompt.
  const context: AgentContext = {
    messages: [{ role: "system", content: DROPPER_SYSTEM, timestamp: Date.now() }],
    tools: [dropObservations],
  };
  const reasoning = model.reasoning;
  const thinkingLevel = args.thinkingLevel ?? "low";
  const effectiveMaxTurns =
    args.maxTurns !== undefined && args.maxTurns > 0 ? args.maxTurns : undefined;
  let turnCount = 0;
  const config: AgentLoopConfig = {
    model,
    apiKey,
    headers,
    env,
    maxTokens: boundedMaxTokens(model, args.maxOutputTokens ?? AGENT_LOOP_MAX_TOKENS),
    convertToLlm: (msgs) =>
      msgs.filter(
        (msg): msg is Message =>
          msg.role === "system" ||
          msg.role === "user" ||
          msg.role === "assistant" ||
          msg.role === "toolResult",
      ),
    toolExecution: "sequential",
    ...(reasoning === undefined || thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
    ...(effectiveMaxTurns === undefined
      ? {}
      : { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns }),
  };

  const loop = args.agentLoop ?? agentLoop;
  const stream = loop(
    prompts,
    context,
    config,
    signal,
    resolveWorkerStreamSimple(model, args.modelRegistry, args.streamSimple),
  );
  const streamError = await drainWorkerStream("dropper", stream);
  const droppedIds = selectDropCandidates(
    proposedDropIds,
    observations,
    maxDropsAllowed,
    reflections,
  );
  if (streamError !== undefined && droppedIds.length === 0) {
    throw new DropperStreamError(streamError.stopReason, streamError.errorMessage);
  }
  const reason = selectDropReason(droppedIds.length, stats.toolCalls, proposedDropIds.length);
  const selectedDropTokens = droppedIds.reduce(
    (sum, id) => sum + (allowed.get(id)?.tokenCount ?? 0),
    0,
  );
  debugLog("dropper.result", {
    reason,
    toolCallCount: stats.toolCalls,
    rawRequestedIdsCount: stats.rawRequested,
    missingIdsCount: stats.missing,
    criticalCandidateIdsCount: stats.critical,
    duplicateInRequestCount: stats.duplicatesInRequest,
    duplicateInRunCount: stats.duplicatesInRun,
    acceptedCandidateCount: proposedDropIds.length,
    selectedDropsCount: droppedIds.length,
    selectedDropTokens,
    selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(
      droppedIds,
      observations,
      coverageById,
    ),
    maxDropsAllowed,
  });
  return droppedIds.length > 0 ? droppedIds : undefined;
}
