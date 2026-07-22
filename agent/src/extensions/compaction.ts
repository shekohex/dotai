import {
  convertToLlm,
  serializeConversation,
  type compact,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { errorMessage } from "../utils/error-message.js";
import {
  DEFAULT_MODEL_FALLBACKS,
  isAbortSignalAborted,
  modelForOpenAIResponses,
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
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
} from "./compaction/openai-remote-messages.js";
import {
  buildRemoteCompactionTools,
  callRemoteCompactionEndpoint,
  remoteCompactionEndpointUrl,
  remoteCompactionModelKey,
  supportsOpenAIRemoteCompaction,
} from "./compaction/openai-remote-protocol.js";
import {
  applyRemoteHistoryPayload,
  buildRemoteCompactionDetails,
  extractResponsesRequestShape,
  messageMatchesModel,
  reconstructRemoteCompactionState,
  remoteCompactionSummaryText,
  thinkingLevelToResponsesReasoning,
} from "./compaction/openai-remote-state.js";
import type {
  RemoteCompactionResult,
  RemoteCompactionSessionState,
  ResponsesReasoningConfig,
  ResponsesTextConfig,
} from "./compaction/openai-remote-types.js";

type CompactionPreparation = Parameters<typeof compact>[0];
const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

type ResponsesRequestShape = {
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
};

export default function (pi: ExtensionAPI) {
  const remoteCompactionStates = new Map<string, RemoteCompactionSessionState>();
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
    syncRemoteCompactionState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    requestShapes.delete(ctx.sessionManager.getSessionId());
    syncRemoteCompactionState(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    syncRemoteCompactionState(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    requestShapes.delete(ctx.sessionManager.getSessionId());
  });
  pi.on("session_shutdown", () => {
    remoteCompactionStates.clear();
    requestShapes.clear();
  });

  pi.on("session_before_compact", async (event, ctx) => {
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
    let remoteResult: RemoteCompactionResult;
    try {
      remoteResult = await createRemoteCompaction({
        pi,
        ctx,
        model,
        sessionId,
        branchEntries: event.branchEntries,
        remoteState: matchingRemoteState(remoteCompactionStates, sessionId, model),
        requestShape: requestShapes.get(sessionId),
        signal,
      });
    } catch (error) {
      if (isAbortSignalAborted(signal)) return {};
      ctx.ui.notify(
        `Compaction [server] failed; starting the portable fallback. ${errorMessage(error)}`,
        "warning",
      );
      const fallbackSummary = await summarizeWithFallbacks(
        ctx,
        allMessages,
        preparation.previousSummary,
        event.customInstructions,
        signal,
        preparation.tokensBefore,
      );
      return fallbackSummary === undefined
        ? {}
        : buildCompactionResult(fallbackSummary, preparation, sanitizedPreparation.details);
    }

    ctx.ui.notify(
      `Compaction [server]: complete for ${modelLabel(model)}; native history was stored without running a fallback model.`,
      "info",
    );
    return buildCompactionResult(remoteCompactionSummaryText(model), preparation, {
      ...sanitizedPreparation.details,
      remoteCompaction: buildRemoteCompactionDetails(
        model,
        remoteResult.output,
        remoteResult.usage,
      ),
    });
  });

  pi.on("message_end", (event, ctx) => {
    const model = ctx.model;
    if (!supportsOpenAIRemoteCompaction(model)) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const remoteState = matchingRemoteState(remoteCompactionStates, sessionId, model);
    if (remoteState === undefined) return;
    if (event.message.role === "assistant" && !messageMatchesModel(event.message, model)) return;
    const items = messageToResponseItems(event.message);
    if (items.length === 0) return;
    remoteCompactionStates.set(sessionId, {
      ...remoteState,
      explicitHistory: [...remoteState.explicitHistory, ...items],
    });
  });

  pi.on("before_provider_request", (event, ctx) =>
    rewriteRemoteCompactionRequest(event.payload, ctx, remoteCompactionStates, requestShapes),
  );
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
  requestShapes: Map<string, ResponsesRequestShape>,
): Record<string, unknown> | undefined {
  let rewrittenPayload: Record<string, unknown> | undefined;
  const model = ctx.model;
  if (supportsOpenAIRemoteCompaction(model)) {
    const sessionId = ctx.sessionManager.getSessionId();
    const requestShape = extractResponsesRequestShape(payload);
    if (requestShape !== undefined) requestShapes.set(sessionId, requestShape);
    const remoteState = matchingRemoteState(remoteCompactionStates, sessionId, model);
    if (remoteState !== undefined) {
      rewrittenPayload = applyRemoteHistoryPayload(
        payload,
        normalizeResponseItemsForPrompt(remoteState.explicitHistory, model),
      );
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
  return state?.modelKey === remoteCompactionModelKey(model) ? state : undefined;
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
  branchEntries: SessionEntry[];
  remoteState?: RemoteCompactionSessionState;
  requestShape?: ResponsesRequestShape;
  signal?: AbortSignal;
}): Promise<RemoteCompactionResult> {
  const auth = await params.ctx.modelRegistry.getApiKeyAndHeaders(params.model);
  if (!auth.ok) throw new Error(`Auth failed for ${params.model.id}: ${auth.error}`);
  if (auth.apiKey === undefined || auth.apiKey.length === 0) {
    throw new Error(`No API key available for ${params.model.id}`);
  }
  const branchMessages = getBranchMessages(params.branchEntries);
  const responseItems =
    params.remoteState?.explicitHistory ?? messagesToResponseItems(branchMessages);
  const reasoning =
    params.requestShape?.reasoning ??
    fallbackRemoteReasoning(params.model, params.pi.getThinkingLevel());

  return callRemoteCompactionEndpoint({
    model: params.model,
    apiKey: auth.apiKey,
    headers: auth.headers,
    sessionId: params.sessionId,
    input: normalizeResponseItemsForPrompt(responseItems, params.model),
    instructions: params.ctx.getSystemPrompt(),
    tools: buildRemoteCompactionTools(params.pi.getAllTools(), params.pi.getActiveTools()),
    reasoning,
    text: params.requestShape?.text,
    signal: params.signal,
  });
}

function getBranchMessages(entries: readonly SessionEntry[]): AgentMessage[] {
  return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

function fallbackRemoteReasoning(
  model: Model<Api>,
  thinkingLevel: ThinkingLevel,
): ResponsesReasoningConfig | undefined {
  return model.reasoning ? thinkingLevelToResponsesReasoning(thinkingLevel) : undefined;
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
    modelForOpenAIResponses(modelAuth.model),
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
