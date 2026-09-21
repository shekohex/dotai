import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

import { supportsOpenAIRemoteCompaction } from "../../compaction/openai-remote-protocol.js";
import { reconstructRemoteCompactionState } from "../../compaction/openai-remote-state.js";
import type { Runtime } from "../runtime.js";
import { buildCompactionProjection, renderSummary, type Entry } from "../session-ledger/index.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
  const value = (runtime.config as { observationsPoolMaxTokens?: unknown })
    .observationsPoolMaxTokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
  pi.on("session_before_compact", (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    return handleBeforeCompact(event, ctx, runtime);
  });
}

/**
 * Handle a pre-compaction event: coordinate with server-side compaction, then either decline or
 * return the deterministic om fold.
 *
 * @param {SessionBeforeCompactEvent} event Pre-compaction event with preparation and branch
 *   entries.
 * @param {ExtensionContext} ctx Extension context for model + UI access.
 * @param {Runtime} runtime Shared om runtime.
 * @returns {Promise<
 *   | { cancel: true }
 *   | {
 *       compaction: {
 *         summary: string;
 *         firstKeptEntryId: string;
 *         tokensBefore: number;
 *         details: unknown;
 *       };
 *     }
 *   | undefined
 * >}
 *   Cancel, a compaction result, or undefined to decline ownership.
 */
function handleBeforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  runtime: Runtime,
): SessionBeforeCompactResult | undefined {
  {
    if (runtime.compactHookInFlight) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "Observational memory: another compaction is already in progress; cancelling duplicate",
          "warning",
        );
      }
      return { cancel: true };
    }

    runtime.compactHookInFlight = true;
    try {
      // Server-side (OpenAI/Codex) compaction owns this event. The om fold must never
      // override a remote compaction, and a session that already carries an encrypted
      // remote checkpoint must keep compacting through the remote/native fallback path
      // so the encrypted window stays intact (see the provider-lock invariant in
      // extensions/compaction.ts). om stays active as ledger + recall + reminder.
      if (supportsOpenAIRemoteCompaction(ctx.model)) return undefined;
      if (reconstructRemoteCompactionState(event.branchEntries) !== undefined) return undefined;

      runtime.ensureConfig(ctx.cwd);
      const { preparation, branchEntries } = event;
      const { firstKeptEntryId, tokensBefore } = preparation;
      const projection = buildCompactionProjection(branchEntries as Entry[], firstKeptEntryId, {
        observationsPoolMaxTokens: observationsPoolMaxTokens(runtime),
      });
      const summary = renderSummary(projection.reflections, projection.observations);
      if (summary.length === 0) {
        // Decline ownership so Pi's native summarizer preserves the pre-cut context.
        return undefined;
      }

      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
          details: projection.details,
        },
      };
    } finally {
      runtime.compactHookInFlight = false;
    }
  }
}
