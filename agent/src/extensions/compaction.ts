import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type compact,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { errorMessage } from "../utils/error-message.js";
import { asRecord } from "../utils/unknown-data.js";
import {
  DEFAULT_MODEL_FALLBACKS,
  isAbortSignalAborted,
  resolveModelFallbackAuth,
  type ModelAuth,
} from "./model-fallbacks.js";

export { isAbortSignalAborted } from "./model-fallbacks.js";
import {
  mergeCompactSanitizeStats,
  sanitizeMessagesForCompact,
} from "./context-prune/compact-sanitizer.js";
import { getContextPruneAPI } from "./context-prune/public-api.js";
import { completeModel } from "./pi-ai-models.js";
import {
  messageToResponseItems,
  normalizeResponseItemsForPrompt,
} from "./compaction/openai-remote-messages.js";
import {
  buildRemoteCompactionTools,
  callRemoteCompactionEndpoint,
  remoteCompactionEndpointUrl,
  remoteCompactionModelKey,
  supportsOpenAIRemoteCompaction,
} from "./compaction/openai-remote-protocol.js";
import { rewriteRemoteCompactionPayload } from "./compaction/openai-remote-replay.js";
import {
  buildRemoteCompactionDetails,
  extractResponsesRequestShape,
  reconstructRemoteCompactionState,
  remoteCompactionSummaryText,
} from "./compaction/openai-remote-state.js";
import type {
  RemoteCompactionResult,
  RemoteCompactionSessionState,
  ResponseItem,
  ResponsesRequestShape,
  ResponsesReasoningConfig,
} from "./compaction/openai-remote-types.js";

type CompactionPreparation = Parameters<typeof compact>[0];
const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
const USE_PI_COMPACTION = undefined;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const LITELLM_CONTEXT_OVERFLOW_PATTERN = /(?:ContextWindowExceededError|Context Window exceeded)/i;
const STANDARD_CONTEXT_OVERFLOW_PATTERN = /context[_ ]length[_ ]exceeded/i;

export default function (pi: ExtensionAPI) {
  const remoteCompactionStates = new Map<string, RemoteCompactionSessionState>();
  const pendingPiFallbackWindows = new Map<string, RemoteCompactionSessionState>();
  const requestShapes = new Map<string, ResponsesRequestShape>();

  const syncRemoteCompactionState = (ctx: ExtensionContext): void => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = reconstructRemoteCompactionState(ctx.sessionManager.getBranch());
    if (state === undefined) {
      remoteCompactionStates.delete(sessionId);
    } else {
      remoteCompactionStates.set(sessionId, state);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    requestShapes.delete(ctx.sessionManager.getSessionId());
    pendingPiFallbackWindows.delete(ctx.sessionManager.getSessionId());
    syncRemoteCompactionState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    requestShapes.delete(ctx.sessionManager.getSessionId());
    pendingPiFallbackWindows.delete(ctx.sessionManager.getSessionId());
    syncRemoteCompactionState(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    syncRemoteCompactionState(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    requestShapes.delete(ctx.sessionManager.getSessionId());
    pendingPiFallbackWindows.delete(ctx.sessionManager.getSessionId());
    syncRemoteCompactionState(ctx);
  });
  pi.on("session_shutdown", () => {
    remoteCompactionStates.clear();
    pendingPiFallbackWindows.clear();
    requestShapes.clear();
  });

  pi.on("session_before_compact", (event, ctx) =>
    handleSessionBeforeCompact(
      event,
      ctx,
      pi,
      remoteCompactionStates,
      pendingPiFallbackWindows,
      requestShapes,
    ),
  );

  pi.on("message_end", (event, ctx) => {
    const model = ctx.model;
    if (!supportsOpenAIRemoteCompaction(model)) return {};
    const message = normalizeLiteLLMContextOverflowMessage(event.message);
    const sessionId = ctx.sessionManager.getSessionId();
    const remoteState = matchingRemoteState(remoteCompactionStates, sessionId, model);
    if (remoteState !== undefined) {
      const items = messageToResponseItems(message);
      if (items.length > 0) {
        remoteCompactionStates.set(sessionId, {
          ...remoteState,
          explicitHistory: [...remoteState.explicitHistory, ...items],
        });
      }
    }
    return message === event.message ? {} : { message };
  });

  pi.on("before_provider_request", (event, ctx) =>
    rewriteRemoteCompactionRequest(
      event.payload,
      ctx,
      remoteCompactionStates,
      pendingPiFallbackWindows,
      requestShapes,
    ),
  );
}

function normalizeLiteLLMContextOverflowMessage(
  message: Parameters<typeof messageToResponseItems>[0],
): Parameters<typeof messageToResponseItems>[0] {
  if (
    message.role !== "assistant" ||
    message.stopReason !== "error" ||
    message.errorMessage === undefined ||
    !LITELLM_CONTEXT_OVERFLOW_PATTERN.test(message.errorMessage) ||
    STANDARD_CONTEXT_OVERFLOW_PATTERN.test(message.errorMessage)
  ) {
    return message;
  }

  return {
    ...message,
    errorMessage: `context_length_exceeded: ${message.errorMessage}`,
  };
}

async function handleSessionBeforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  remoteCompactionStates: Map<string, RemoteCompactionSessionState>,
  pendingPiFallbackWindows: Map<string, RemoteCompactionSessionState>,
  requestShapes: Map<string, ResponsesRequestShape>,
) {
  const preparation = event.preparation;
  const signal = event.signal;
  const sanitizedPreparation = sanitizePreparationForCompaction(ctx, preparation);
  const allMessages = [
    ...sanitizedPreparation.messagesToSummarize,
    ...sanitizedPreparation.turnPrefixMessages,
  ];
  const model = ctx.model;

  if (!supportsOpenAIRemoteCompaction(model)) {
    ctx.ui.notify(
      `Compaction [fallback]: OpenAI server-side compaction is unavailable for ${modelLabel(model)}; using a portable text summary.`,
      "info",
    );
    const summary = await summarizeWithFallbacks(
      ctx,
      allMessages,
      preparation.previousSummary,
      event.customInstructions,
      signal,
      preparation.tokensBefore,
    );
    return summary === undefined
      ? {}
      : buildCompactionResult(summary, preparation, sanitizedPreparation.details);
  }

  ctx.ui.notify(
    `Compaction [server]: requesting OpenAI-native compaction with ${modelLabel(model)} via ${remoteCompactionHost(model)}.`,
    "info",
  );
  const sessionId = ctx.sessionManager.getSessionId();
  const persistedRemoteState = remoteCompactionStates.get(sessionId);
  const compatibleRemoteState = matchingRemoteState(remoteCompactionStates, sessionId, model);
  const latestCompactionEntryId = ctx.sessionManager
    .getBranch()
    .toReversed()
    .find((entry) => entry.type === "compaction")?.id;
  const latestCompactionIsRemote =
    persistedRemoteState !== undefined &&
    persistedRemoteState.compactionEntryId === latestCompactionEntryId;
  if (latestCompactionIsRemote && compatibleRemoteState === undefined) {
    ctx.ui.notify(
      "OpenAI native compaction cannot reuse the latest checkpoint with this provider or endpoint; compaction was cancelled to preserve its encrypted history.",
      "error",
    );
    return { cancel: true };
  }
  const remoteState = latestCompactionIsRemote ? compatibleRemoteState : undefined;
  const requestShape = requestShapes.get(sessionId);
  if (event.customInstructions !== undefined && event.customInstructions.trim().length > 0) {
    ctx.ui.notify(
      "Responses compaction v2 uses the active session instructions and ignores custom /compact guidance.",
      "warning",
    );
  }
  let remoteResult: RemoteCompactionResult;
  try {
    remoteResult = await createRemoteCompaction({
      pi,
      ctx,
      model,
      sessionId,
      remoteState,
      requestShape,
      tokensBefore: preparation.tokensBefore,
      signal,
    });
  } catch (error) {
    if (isAbortSignalAborted(signal)) {
      return { cancel: true };
    }
    if (remoteState !== undefined) pendingPiFallbackWindows.set(sessionId, remoteState);
    ctx.ui.notify(
      `Compaction [server] failed; Pi compaction will run.${remoteState === undefined ? "" : " Previous native compacted window will be included in Pi compaction fallback."} ${errorMessage(error)}`,
      "warning",
    );
    return USE_PI_COMPACTION;
  }

  ctx.ui.notify(
    `Compaction [server]: complete for ${modelLabel(model)}; native history was stored without running a fallback model.`,
    "info",
  );
  return buildNativeCompactionResult(remoteCompactionSummaryText(), preparation, {
    ...sanitizedPreparation.details,
    remoteCompaction: buildRemoteCompactionDetails(model, {
      replacementHistory: remoteResult.output,
      compactResponseId: remoteResult.compactResponseId,
      createdAt: remoteResult.createdAt,
      requestMeta: {
        tokensBefore: preparation.tokensBefore,
        previousSummaryPresent: preparation.previousSummary !== undefined,
        compactedKeptWindow: remoteState === undefined,
      },
      usage: remoteResult.usage,
    }),
  });
}

function modelLabel(model: Model<Api> | undefined): string {
  return model === undefined ? "the current model" : `${model.provider}/${model.id}`;
}

function remoteCompactionHost(model: Model<Api>): string {
  try {
    return new URL(remoteCompactionEndpointUrl(model)).host;
  } catch {
    return model.baseUrl;
  }
}

function rewriteRemoteCompactionRequest(
  payload: unknown,
  ctx: ExtensionContext,
  remoteCompactionStates: Map<string, RemoteCompactionSessionState>,
  pendingPiFallbackWindows: Map<string, RemoteCompactionSessionState>,
  requestShapes: Map<string, ResponsesRequestShape>,
): Record<string, unknown> | undefined {
  let rewrittenPayload: Record<string, unknown> | undefined;
  const model = ctx.model;
  if (supportsOpenAIRemoteCompaction(model)) {
    const sessionId = ctx.sessionManager.getSessionId();
    const pendingPiFallback = pendingPiFallbackWindows.get(sessionId);
    if (
      pendingPiFallback !== undefined &&
      remoteStateMatchesModel(pendingPiFallback, model) &&
      isPiCompactionSummarizationPayload(payload)
    ) {
      pendingPiFallbackWindows.delete(sessionId);
      return injectNativeWindowIntoPiCompaction(payload, pendingPiFallback.replacementHistory);
    }
    const requestShape = extractResponsesRequestShape(payload);
    if (requestShape !== undefined) requestShapes.set(sessionId, requestShape);
    const persistedRemoteState = remoteCompactionStates.get(sessionId);
    const remoteState = matchingRemoteState(remoteCompactionStates, sessionId, model);
    if (persistedRemoteState !== undefined && remoteState === undefined) {
      throw new Error(
        "OpenAI native compaction replay was cancelled because the latest checkpoint belongs to another provider or endpoint.",
      );
    }
    if (remoteState !== undefined) {
      const replay = rewriteRemoteCompactionPayload({
        model,
        payload,
        branchEntries: ctx.sessionManager.getBranch(),
        state: remoteState,
      });
      if (!replay.ok) {
        const detail = replay.mismatches?.slice(0, 3).join("; ");
        const message = `OpenAI native compaction replay failed (${replay.reason})${detail !== undefined && detail.length > 0 ? `: ${detail}` : ""}; request was not sent with placeholder compaction context.`;
        ctx.ui.notify(message, "error");
        throw new Error(message);
      }
      rewrittenPayload = replay.rewrittenPayload;
    }
  }
  return rewrittenPayload;
}

function matchingRemoteState(
  states: Map<string, RemoteCompactionSessionState>,
  sessionId: string,
  model: Model<Api>,
): RemoteCompactionSessionState | undefined {
  const state = states.get(sessionId);
  return state !== undefined && remoteStateMatchesModel(state, model) ? state : undefined;
}

function remoteStateMatchesModel(state: RemoteCompactionSessionState, model: Model<Api>): boolean {
  if (
    state.sourceProvider !== undefined &&
    state.api !== undefined &&
    state.baseUrl !== undefined
  ) {
    const normalizedStateBaseUrl = state.baseUrl.trim().replace(/\/+$/u, "");
    const normalizedModelBaseUrl = model.baseUrl.trim().replace(/\/+$/u, "");
    return (
      state.sourceProvider === model.provider &&
      state.api === model.api &&
      normalizedStateBaseUrl === normalizedModelBaseUrl
    );
  }
  return state.modelKey === remoteCompactionModelKey(model);
}

function isPiCompactionSummarizationPayload(payload: unknown): boolean {
  const record = asRecord(payload);
  if (record === undefined || !Array.isArray(record.input)) return false;
  if (typeof record.instructions === "string" && /compact|summar/iu.test(record.instructions)) {
    return true;
  }
  return record.input.some((value) => {
    const item = asRecord(value);
    if (item === undefined) return false;
    let text = "";
    if (typeof item.content === "string") {
      text = item.content;
    } else if (Array.isArray(item.content)) {
      text = item.content
        .flatMap((part: unknown) => {
          const content = asRecord(part);
          return typeof content?.text === "string" ? [content.text] : [];
        })
        .join("\n");
    }
    return (
      ((item.role === "system" || item.role === "developer") && /compact|summar/iu.test(text)) ||
      (item.role === "user" && /<conversation>|previous compaction summary|summary/iu.test(text))
    );
  });
}

function injectNativeWindowIntoPiCompaction(
  payload: unknown,
  nativeWindow: ResponseItem[],
): Record<string, unknown> | undefined {
  const record = asRecord(payload);
  if (record === undefined || !Array.isArray(record.input)) return undefined;
  const input: unknown[] = record.input;
  let insertAt = 0;
  while (insertAt < input.length) {
    const role = asRecord(input[insertAt])?.role;
    if (role !== "system" && role !== "developer") break;
    insertAt += 1;
  }
  return {
    ...record,
    input: [
      ...input.slice(0, insertAt),
      ...nativeWindow.map((item) => structuredClone(item)),
      ...input.slice(insertAt),
    ],
  };
}

function buildCompactionResult(
  summary: string,
  preparation: CompactionPreparation,
  details: unknown,
) {
  return {
    compaction: {
      summary: `${SUMMARY_PREFIX}\n\n${summary}`,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details,
    },
  };
}

function buildNativeCompactionResult(
  summary: string,
  preparation: CompactionPreparation,
  details: unknown,
) {
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details,
    },
  };
}

async function summarizeWithFallbacks(
  ctx: ExtensionContext,
  allMessages: Parameters<typeof convertToLlm>[0],
  previousSummary: string | undefined,
  customInstructions: string | undefined,
  signal: AbortSignal | undefined,
  tokensBefore: number,
): Promise<string | undefined> {
  for (const fallbackModel of DEFAULT_MODEL_FALLBACKS) {
    const modelAuth = await resolveModelFallbackAuth(ctx, fallbackModel, "Compaction");
    if (modelAuth === undefined) continue;

    ctx.ui.notify(
      `Compaction [fallback]: generating portable summary for ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${modelLabel(modelAuth.model)}...`,
      "info",
    );
    try {
      const summary = await summarizeCompaction(
        modelAuth,
        allMessages,
        previousSummary,
        customInstructions,
        signal,
      );
      if (summary.trim().length === 0) {
        if (!isAbortSignalAborted(signal)) {
          ctx.ui.notify(
            `Compaction [fallback]: summary was empty for ${modelLabel(modelAuth.model)}, trying the next model`,
            "warning",
          );
        }
        continue;
      }
      return summary;
    } catch (error) {
      if (!isAbortSignalAborted(signal)) {
        ctx.ui.notify(
          `Compaction [fallback]: ${modelLabel(modelAuth.model)} failed: ${errorMessage(error)}. Trying the next model`,
          "error",
        );
      }
    }
  }

  if (!isAbortSignalAborted(signal)) {
    ctx.ui.notify(
      "Compaction [fallback]: model list exhausted; using Pi's default compaction",
      "warning",
    );
  }
  return undefined;
}

async function createRemoteCompaction(params: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  model: Model<Api>;
  sessionId: string;
  remoteState?: RemoteCompactionSessionState;
  requestShape?: ResponsesRequestShape;
  tokensBefore: number;
  signal?: AbortSignal;
}): Promise<RemoteCompactionResult> {
  const auth = await params.ctx.modelRegistry.getApiKeyAndHeaders(params.model);
  if (!auth.ok) throw new Error(`Auth failed for ${params.model.id}: ${auth.error}`);
  if (auth.apiKey === undefined || auth.apiKey.length === 0) {
    throw new Error(`No API key available for ${params.model.id}`);
  }
  const branchMessages = buildSessionContext(
    params.ctx.sessionManager.getEntries(),
    params.ctx.sessionManager.getLeafId(),
  ).messages;
  const responseItems =
    params.remoteState?.explicitHistory ??
    normalizeResponseItemsForPrompt(
      convertResponsesMessages(
        params.model,
        { messages: convertToLlm(branchMessages) },
        CODEX_TOOL_CALL_PROVIDERS,
        { includeSystemPrompt: false },
      ),
      params.model,
    );
  const reasoning =
    params.requestShape?.reasoning ??
    fallbackRemoteReasoning(params.model, params.pi.getThinkingLevel());

  return callRemoteCompactionEndpoint({
    model: params.model,
    apiKey: auth.apiKey,
    headers: auth.headers,
    sessionId: params.sessionId,
    tokensBefore: params.tokensBefore,
    input: normalizeResponseItemsForPrompt(responseItems, params.model),
    instructions: params.requestShape?.instructions ?? params.ctx.getSystemPrompt(),
    tools: buildRemoteCompactionTools(
      params.model,
      params.pi.getAllTools(),
      params.pi.getActiveTools(),
      params.requestShape?.tools,
    ),
    reasoning,
    text: params.requestShape?.text,
    serviceTier: params.requestShape?.serviceTier,
    signal: params.signal,
  });
}

function fallbackRemoteReasoning(
  model: Model<Api>,
  thinkingLevel: ThinkingLevel,
): ResponsesReasoningConfig | undefined {
  if (!model.reasoning || thinkingLevel === "off") return undefined;
  const clampedLevel = clampThinkingLevel(model, toModelThinkingLevel(thinkingLevel));
  const rawEffort = model.thinkingLevelMap?.[clampedLevel] ?? clampedLevel;
  if (typeof rawEffort !== "string") return undefined;
  const effort = clampCodexReasoningEffort(model.id, rawEffort);
  if (!isReasoningEffort(effort)) return undefined;
  return { effort, summary: "auto" };
}

function toModelThinkingLevel(thinkingLevel: ThinkingLevel): ModelThinkingLevel {
  if (thinkingLevel === "minimal") return "minimal";
  if (thinkingLevel === "low") return "low";
  if (thinkingLevel === "medium") return "medium";
  if (thinkingLevel === "high") return "high";
  if (thinkingLevel === "xhigh") return "xhigh";
  return "off";
}

function isReasoningEffort(
  effort: string,
): effort is NonNullable<ResponsesReasoningConfig["effort"]> {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort);
}

function clampCodexReasoningEffort(modelId: string, effort: string): string {
  const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  const gpt5MinorMatch = /^gpt-5\.(\d+)/u.exec(id);
  const gpt5Minor = gpt5MinorMatch?.[1];
  if (gpt5Minor !== undefined && Number.parseInt(gpt5Minor, 10) >= 2 && effort === "minimal") {
    return "low";
  }
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini") {
    return effort === "high" || effort === "xhigh" ? "high" : "medium";
  }
  return effort;
}

function sanitizePreparationForCompaction(
  ctx: ExtensionContext,
  preparation: CompactionPreparation,
) {
  const pruner = getContextPruneAPI(ctx);
  if (pruner === null || pruner.getIndexer().getIndex().size === 0) {
    return { ...preparation, details: undefined };
  }
  const indexer = pruner.getIndexer();
  const summarized = sanitizeMessagesForCompact(preparation.messagesToSummarize, indexer);
  const turnPrefix = sanitizeMessagesForCompact(preparation.turnPrefixMessages, indexer);
  const stats = mergeCompactSanitizeStats(summarized.stats, turnPrefix.stats);
  return {
    ...preparation,
    messagesToSummarize: summarized.messages,
    turnPrefixMessages: turnPrefix.messages,
    details: stats.changed ? { contextPrune: { sanitized: true, ...stats } } : undefined,
  };
}

async function summarizeCompaction(
  modelAuth: ModelAuth,
  allMessages: Parameters<typeof convertToLlm>[0],
  previousSummary: string | undefined,
  customInstructions: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await completeModel(
    modelAuth.model,
    { messages: buildSummaryMessages(allMessages, previousSummary, customInstructions) },
    {
      apiKey: modelAuth.apiKey,
      headers: modelAuth.headers,
      maxTokens: 8192,
      signal,
    },
  );

  return response.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export function buildSummaryMessages(
  messages: Parameters<typeof convertToLlm>[0],
  previousSummary: string | undefined,
  customInstructions: string | undefined,
) {
  const conversationText = serializeConversation(convertToLlm(messages));
  const previousContext =
    previousSummary !== undefined && previousSummary.length > 0
      ? `\n\nPrevious session summary for context:\n${previousSummary}`
      : "";
  const additionalInstructions =
    customInstructions !== undefined && customInstructions.trim().length > 0
      ? `\n\n# Additional Constraints And Instructions\n${customInstructions.trim()}`
      : "";

  return [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
Create a comprehensive summary of this conversation that captures:${previousContext}${additionalInstructions}

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
Format the summary as structured markdown with clear sections.

<conversation>
${conversationText}
</conversation>`,
        },
      ],
      timestamp: Date.now(),
    },
  ];
}
