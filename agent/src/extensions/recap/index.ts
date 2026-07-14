import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import stripAnsi from "strip-ansi";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import {
  DEFAULT_MODEL_FALLBACKS,
  modelForOpenAIResponses,
  resolveModelFallbackAuth,
} from "../model-fallbacks.js";
import { completeModel } from "../pi-ai-models.js";
import { getRecapSettings, type RecapSettings } from "./settings.js";

const RECAP_ENTRY_TYPE = "recap:state";
const RECAP_WIDGET_KEY = "recap";
const RECAP_MAX_TOKENS = 160;
const RECAP_TIMEOUT_MS = 30_000;
const RECAP_SYSTEM_PROMPT = `You write compact recaps for an AI coding-agent session.

Given the current session context, produce one plain-text sentence for the user to resume later.
Start with the user's goal or reason for the session, inferred from user messages. Do not start with the assistant's answer.
Then include the current outcome, important decision, touched file, blocker, or likely next action only if it helps resume.
Prefer: Goal/purpose. Current state. Next action.
Target about 160 characters. Stay under 240 characters.
Do not add a label or prefix. Do not use markdown. Do not mention yourself as "the assistant".

Good: Deciding whether pi-inline-skills should switch from $skill to /skill. Recommendation is / only with commands winning; next decide whether leading /skill should expand.
Bad: Feasible; I’d default to / and skip config. Extension commands win first; next decide whether leading /skill tokens should expand.`;

const PersistedRecapStateSchema = Type.Object({
  version: Type.Literal(1),
  recap: Type.String(),
  contextLeafId: Type.Union([Type.String(), Type.Null()]),
});

type PersistedRecapState = Static<typeof PersistedRecapStateSchema>;

interface RecapState {
  active: boolean;
  generationId: number;
  lastRecap: string;
  current: boolean;
  visible: boolean;
  settings: RecapSettings;
  abortController: AbortController | undefined;
  awayTimer: ReturnType<typeof setTimeout> | undefined;
}

type RecapSessionEntry = Extract<SessionEntry, { type: "custom" }> & {
  customType: typeof RECAP_ENTRY_TYPE;
  data: PersistedRecapState;
};

function createState(): RecapState {
  return {
    active: false,
    generationId: 0,
    lastRecap: "",
    current: false,
    visible: false,
    settings: getRecapSettings(),
    abortController: undefined,
    awayTimer: undefined,
  };
}

function isRecapEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> & {
  customType: typeof RECAP_ENTRY_TYPE;
} {
  return entry.type === "custom" && entry.customType === RECAP_ENTRY_TYPE;
}

function isPersistedState(data: unknown): data is PersistedRecapState {
  return Value.Check(PersistedRecapStateSchema, data);
}

function isPersistedRecapEntry(entry: SessionEntry): entry is RecapSessionEntry {
  return isRecapEntry(entry) && isPersistedState(entry.data);
}

function getContextLeafId(ctx: ExtensionContext): string | null {
  return (
    ctx.sessionManager
      .getBranch()
      .toReversed()
      .find((entry) => !isRecapEntry(entry))?.id ?? null
  );
}

function getSessionMessages(ctx: ExtensionContext, contextLeafId: string | null) {
  return buildSessionContext(ctx.sessionManager.getEntries(), contextLeafId).messages;
}

function sanitizeRecap(value: string): string {
  const printableText = Array.from(stripAnsi(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    return isControl ? " " : character;
  }).join("");
  const normalized = printableText.replaceAll(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= 320 ? normalized : `${characters.slice(0, 319).join("")}…`;
}

function extractResponseText(content: AssistantMessage["content"]): string {
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function clearTimer(state: RecapState): void {
  if (state.awayTimer === undefined) return;
  clearTimeout(state.awayTimer);
  state.awayTimer = undefined;
}

function abortGeneration(state: RecapState): void {
  state.abortController?.abort();
  state.abortController = undefined;
}

function hideRecap(ctx: ExtensionContext, state: RecapState): void {
  state.visible = false;
  if (ctx.hasUI) ctx.ui.setWidget(RECAP_WIDGET_KEY, undefined);
}

function showRecap(ctx: ExtensionContext, state: RecapState): void {
  if (!ctx.hasUI || state.lastRecap.length === 0) return;
  state.visible = true;
  ctx.ui.setWidget(RECAP_WIDGET_KEY, [`※ recap: ${state.lastRecap}`], {
    placement: "aboveEditor",
  });
}

function restoreRecap(ctx: ExtensionContext, state: RecapState): void {
  const entry = ctx.sessionManager
    .getBranch()
    .toReversed()
    .find((candidate) => isPersistedRecapEntry(candidate));
  if (entry === undefined) return;

  state.lastRecap = entry.data.recap;
  state.current =
    entry.id === ctx.sessionManager.getLeafId() &&
    entry.data.contextLeafId === getContextLeafId(ctx);
}

async function generateRecap(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RecapState,
  manual: boolean,
): Promise<void> {
  if (!state.settings.enabled || !ctx.hasUI) return;

  const contextLeafId = getContextLeafId(ctx);
  const messages = getSessionMessages(ctx, contextLeafId);
  if (messages.length === 0) {
    if (manual) ctx.ui.notify("No conversation to recap yet.", "info");
    return;
  }

  if (manual)
    ctx.ui.setWidget(RECAP_WIDGET_KEY, ["※ recap: generating..."], {
      placement: "aboveEditor",
    });

  const generationId = state.generationId;
  const abortController = new AbortController();
  abortGeneration(state);
  state.abortController = abortController;
  const timeout = setTimeout(() => {
    abortController.abort();
  }, RECAP_TIMEOUT_MS);

  try {
    for (const candidate of DEFAULT_MODEL_FALLBACKS) {
      const modelAuth = await resolveModelFallbackAuth(ctx, candidate, "Recap");
      if (generationId !== state.generationId || !state.active) return;
      if (modelAuth === undefined) continue;

      try {
        const response = await completeModel(
          modelForOpenAIResponses(modelAuth.model),
          {
            systemPrompt: RECAP_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: serializeConversation(convertToLlm(messages)),
                  },
                ],
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: modelAuth.apiKey,
            headers: modelAuth.headers,
            env: modelAuth.env,
            maxTokens: RECAP_MAX_TOKENS,
            signal: abortController.signal,
          },
        );
        if (generationId !== state.generationId || !state.active) return;
        if (response.stopReason !== "stop") continue;

        const recap = sanitizeRecap(extractResponseText(response.content));
        if (recap.length === 0) continue;

        state.lastRecap = recap;
        state.current = true;
        pi.appendEntry<PersistedRecapState>(RECAP_ENTRY_TYPE, {
          version: 1,
          recap,
          contextLeafId,
        });
        showRecap(ctx, state);
        return;
      } catch {
        if (abortController.signal.aborted) break;
      }
    }

    if (manual) {
      hideRecap(ctx, state);
      ctx.ui.notify("Recap generation failed.", "error");
    }
  } finally {
    clearTimeout(timeout);
    if (state.abortController === abortController) state.abortController = undefined;
  }
}

function scheduleAwayRecap(pi: ExtensionAPI, ctx: ExtensionContext, state: RecapState): void {
  clearTimer(state);
  state.awayTimer = setTimeout(() => {
    state.awayTimer = undefined;
    if (!state.active || state.current || !ctx.isIdle()) return;
    void generateRecap(pi, ctx, state, false);
  }, state.settings.awayDelayMs);
}

export default function recapExtension(pi: ExtensionAPI): void {
  const state = createState();

  pi.registerCommand("recap", {
    description: "generate a one-line session recap",
    handler: async (args, ctx) => {
      clearTimer(state);
      if (args.trim() === "status") {
        let recapStatus = "none";
        if (state.lastRecap.length > 0) recapStatus = state.current ? "current" : "stale";
        ctx.ui.notify(
          `recap: ${state.settings.enabled ? "enabled" : "disabled"}; last: ${recapStatus}; visible: ${state.visible ? "yes" : "no"}`,
          "info",
        );
        return;
      }
      if (args.trim().length > 0) {
        ctx.ui.notify("Use /recap or /recap status", "error");
        return;
      }
      await generateRecap(pi, ctx, state, true);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    state.active = true;
    state.generationId++;
    state.settings = getRecapSettings();
    state.lastRecap = "";
    state.current = false;
    state.visible = false;
    clearTimer(state);
    abortGeneration(state);
    hideRecap(ctx, state);
    if (!state.settings.enabled) return;

    restoreRecap(ctx, state);
    if (state.current) showRecap(ctx, state);
    else void generateRecap(pi, ctx, state, false);
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    clearTimer(state);
    if (!/^\/recap(?:\s|$)/u.test(event.text.trimStart())) {
      state.current = false;
      hideRecap(ctx, state);
    }
    return { action: "continue" as const };
  });

  pi.on("agent_start", (_event, ctx) => {
    state.generationId++;
    state.current = false;
    clearTimer(state);
    abortGeneration(state);
    hideRecap(ctx, state);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (state.settings.enabled) scheduleAwayRecap(pi, ctx, state);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    state.active = false;
    state.generationId++;
    clearTimer(state);
    abortGeneration(state);
    hideRecap(ctx, state);
  });
}
