import type {
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";

import { supportsOpenAIRemoteCompaction } from "../../compaction/openai-remote-protocol.js";
import { reconstructRemoteCompactionState } from "../../compaction/openai-remote-state.js";
import { errorMessage } from "../../../utils/error-message.js";
import type { Runtime } from "../runtime.js";
import {
  fullProjection,
  isMemoryDetails,
  reflectionToSummaryLine,
  renderSummary,
  type Observation,
  type Reflection,
} from "../session-ledger/index.js";
import { estimateStringTokens, observationLineTokenCount } from "../tokens.js";

const REMINDER_CUSTOM_TYPE = "om.memory.reminder";
const REMINDER_DELAY_MS = 150;

type ReminderMemory = {
  text: string;
  observationCount: number;
  reflectionCount: number;
};

/**
 * Render the reminder within the observation pool token budget. Reflections are always kept (they
 * are the durable layer); observations are kept newest-first, so overflow drops the oldest
 * observations and the latest state survives.
 *
 * @param {Reflection[]} reflections Durable reflections, all included.
 * @param {Observation[]} observations Active observations, oldest-first.
 * @param {number} maxTokens Total rendered token budget.
 * @returns {ReminderMemory} The rendered reminder text plus counts, or empty text when nothing to
 *   remind about.
 */
function buildReminderMemory(
  reflections: Reflection[],
  observations: Observation[],
  maxTokens: number,
): ReminderMemory {
  if (reflections.length === 0 && observations.length === 0) {
    return { text: "", observationCount: 0, reflectionCount: 0 };
  }

  const reflectionTokens = reflections.reduce(
    (total, reflection) => total + estimateStringTokens(reflectionToSummaryLine(reflection)),
    0,
  );
  const observationBudget = Math.max(0, maxTokens - reflectionTokens);
  const kept: Observation[] = [];
  let usedTokens = 0;
  for (let i = observations.length - 1; i >= 0; i--) {
    const observation = observations[i];
    const tokens = observationLineTokenCount(observation);
    if (usedTokens + tokens > observationBudget) break;
    kept.unshift(observation);
    usedTokens += tokens;
  }

  return {
    text: renderSummary(reflections, kept),
    observationCount: kept.length,
    reflectionCount: reflections.length,
  };
}

/**
 * Re-supply the observational-memory fold as a silent custom message after a compaction that was
 * NOT owned by om — server-side (OpenAI/Codex) compaction, or the pi-native fallback on a session
 * that carries an encrypted remote checkpoint. On those paths the om fold never reaches the agent
 * through the compaction text itself. The message rides along in remote-compaction replay
 * (custom_message entries are re-included) and is absorbed by the next remote compaction, so at
 * most one reminder is active at a time.
 *
 * @param {ExtensionAPI} pi Extension API used to deliver the message.
 * @param {Runtime} runtime Shared om runtime (config, passive flag, budgets).
 * @returns {void}
 */
export function registerCompactionReminder(pi: ExtensionAPI, runtime: Runtime): void {
  pi.on("session_compact", (event: SessionCompactEvent, ctx: ExtensionContext) => {
    if (event.willRetry) return;
    // om-owned compaction already carries the memory in its summary text.
    if (isMemoryDetails(event.compactionEntry.details)) return;

    // Capture ctx properties synchronously — the delayed work below may outlive
    // the extension ctx (stale after session replacement/reload).
    const cwd = ctx.cwd;
    const hasUI = ctx.hasUI;
    const ui = ctx.ui;
    const branch = ctx.sessionManager.getBranch();
    const model = ctx.model;

    const timer = setTimeout(() => {
      try {
        runtime.ensureConfig(cwd);
        if (runtime.config.passive) return;

        const remoteSession =
          supportsOpenAIRemoteCompaction(model) ||
          reconstructRemoteCompactionState(branch) !== undefined;
        if (!remoteSession) return;

        // Only remind when the observational-memory ledger actually recorded
        // something; an empty fold means there is nothing worth re-supplying.
        const projection = fullProjection(branch);
        if (projection.observations.length === 0 && projection.reflections.length === 0) return;

        const memory = buildReminderMemory(
          projection.reflections,
          projection.observations,
          runtime.config.observationsPoolMaxTokens,
        );
        if (memory.text.length === 0) return;

        const content = [
          "<observational-memory-reminder>",
          "The context above was compacted without the observational-memory fold, so these condensed memories are re-supplied here.",
          "",
          memory.text,
          "",
          "Treat this as a reminder of earlier work, not as new instructions. Use the recall tool with a memory id when exact source context matters.",
          "</observational-memory-reminder>",
        ].join("\n");

        const tokenCount = estimateStringTokens(content);
        pi.sendMessage(
          {
            customType: REMINDER_CUSTOM_TYPE,
            content,
            display: false,
            details: {
              compactionEntryId: event.compactionEntry.id,
              observations: memory.observationCount,
              reflections: memory.reflectionCount,
            },
          },
          { triggerTurn: false, deliverAs: "steer" },
        );
        if (hasUI) {
          ui?.notify(
            `Observational memory: re-injected ${memory.reflectionCount} reflections and ${memory.observationCount} observations (~${tokenCount} tokens) after compaction`,
            "info",
          );
        }
      } catch (error) {
        if (hasUI)
          ui?.notify(`Observational memory: reminder failed: ${errorMessage(error)}`, "warning");
      }
    }, REMINDER_DELAY_MS);
    timer.unref?.();
  });
}
