import { stream } from "@mariozechner/pi-ai";
import type { AgentToolUpdateCallback, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_SEARCH_QUERIES,
  MAX_SOURCES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  THINKING_BUDGET,
  WEBSEARCH_MODELS,
  WEBSEARCH_PROVIDER,
  asRecord,
  type WebSearchDetails,
} from "./types.js";
import { buildDetails, formatResult, getAssistantText } from "./parsing.js";
import { emptyResult, extractStreamingAnswerText, parseSearchResponseText } from "./structured.js";

function createWebSearchRequest(
  params: {
    query: string;
    model?: (typeof WEBSEARCH_MODELS)[number];
    timeoutMs?: number;
  },
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): {
  query: string;
  modelId: (typeof WEBSEARCH_MODELS)[number];
  timeoutMs: number;
  startedAt: number;
} {
  const query = params.query.trim();
  if (!query) {
    throw new Error("websearch query is empty");
  }
  const modelId = resolveModel(params.model);
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  const startedAt = Date.now();
  onUpdate?.({
    content: [],
    details: buildDetails(query, modelId, timeoutMs, "", startedAt, emptyResult()),
  });
  return { query, modelId, timeoutMs, startedAt };
}

async function executeWebSearchRequest(
  request: {
    query: string;
    modelId: (typeof WEBSEARCH_MODELS)[number];
    timeoutMs: number;
    startedAt: number;
  },
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: WebSearchDetails }> {
  const model = ctx.modelRegistry.find(WEBSEARCH_PROVIDER, request.modelId);
  if (!model) {
    throw new Error(
      `Gemini model ${request.modelId} is not available. Ensure the LiteLLM-backed provider \`${WEBSEARCH_PROVIDER}\` is loaded.`,
    );
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`Websearch auth failed: ${auth.error}`);
  }
  if (auth.apiKey === undefined || auth.apiKey.length === 0) {
    throw new Error(`No API key for ${model.provider}/${model.id}`);
  }
  const endpoint = `${model.baseUrl.replace(/\/$/, "")}/models/${model.id}:streamGenerateContent?alt=sse`;
  const searchStream = stream(
    model,
    {
      systemPrompt: buildSystemInstruction(),
      messages: [{ role: "user", content: buildUserPrompt(request.query), timestamp: Date.now() }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      onPayload: (payload) => configureGroundedSearchPayload(payload, model.reasoning),
    },
  );
  await emitWebSearchPartials(searchStream, request, endpoint, onUpdate);
  const response = await searchStream.result();
  return finalizeWebSearchResponse(response, request, endpoint);
}

async function emitWebSearchPartials(
  searchStream: ReturnType<typeof stream>,
  request: {
    query: string;
    modelId: (typeof WEBSEARCH_MODELS)[number];
    timeoutMs: number;
    startedAt: number;
  },
  endpoint: string,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): Promise<void> {
  let lastPartialAnswer = "";
  for await (const event of searchStream) {
    if (event.type !== "text_start" && event.type !== "text_delta" && event.type !== "text_end") {
      continue;
    }
    const partialAnswer = extractStreamingAnswerText(getAssistantText(event.partial.content));
    if (!partialAnswer || partialAnswer === lastPartialAnswer) {
      continue;
    }
    lastPartialAnswer = partialAnswer;
    onUpdate?.({
      content: [{ type: "text", text: partialAnswer }],
      details: buildDetails(
        request.query,
        request.modelId,
        request.timeoutMs,
        endpoint,
        request.startedAt,
        {
          answer: partialAnswer,
          sources: [],
          searchQueries: [],
        },
      ),
    });
  }
}

function finalizeWebSearchResponse(
  response: Awaited<ReturnType<ReturnType<typeof stream>["result"]>>,
  request: {
    query: string;
    modelId: (typeof WEBSEARCH_MODELS)[number];
    timeoutMs: number;
    startedAt: number;
  },
  endpoint: string,
): { content: Array<{ type: "text"; text: string }>; details: WebSearchDetails } {
  const text = getAssistantText(response.content).trim();
  if (response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? "Websearch request aborted");
  }
  if (response.stopReason === "error") {
    throw new Error((response.errorMessage ?? text) || "Websearch failed");
  }
  const result = parseSearchResponseText(text);
  if (result.answer.length === 0) {
    throw new Error("Websearch returned no answer");
  }
  return {
    content: [{ type: "text", text: formatResult(result) }],
    details: buildDetails(
      request.query,
      request.modelId,
      request.timeoutMs,
      endpoint,
      request.startedAt,
      result,
    ),
  };
}

function resolveModel(
  model: (typeof WEBSEARCH_MODELS)[number] | undefined,
): (typeof WEBSEARCH_MODELS)[number] {
  return model ?? DEFAULT_MODEL;
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(timeoutMs)));
}

function configureGroundedSearchPayload(payload: unknown, includeThinking: boolean): unknown {
  const request = asRecord(payload);
  if (!request) {
    return payload;
  }
  const config = asRecord(request.config) ?? {};
  config.tools = [{ googleSearch: {} }];
  if (includeThinking) {
    config.thinkingConfig = {
      thinkingBudget: THINKING_BUDGET,
      includeThoughts: false,
    };
  }
  request.config = config;
  return request;
}

function buildSystemInstruction(): string {
  return [
    "<role>",
    "You are a fast web research agent using Google Search grounding.",
    "</role>",
    "",
    "<instructions>",
    "1. Break the query into the smallest useful research questions.",
    "2. Search broadly, verify facts across sources, and prefer official sources.",
    "3. Resolve conflicts explicitly and state uncertainty when needed.",
    "4. Return exactly one JSON object with keys answer, sources, and searchQueries.",
    "5. answer must be Markdown prose only, with no Sources or Search queries headings.",
    "6. sources must contain only URLs you are confident came from grounded search results.",
    "7. searchQueries must list the main web searches you actually used.",
    "</instructions>",
    "",
    "<output_schema>",
    '{"answer":"markdown answer","sources":[{"title":"source title","url":"https://example.com"}],"searchQueries":["query"]}',
    "</output_schema>",
    "",
    "<constraints>",
    "- No code fences",
    "- No prose outside the JSON object",
    "- No fabricated facts or URLs",
    "- Keep the answer concise and technical",
    "</constraints>",
  ].join("\n");
}

function buildUserPrompt(query: string): string {
  return [
    "<task>",
    query,
    "</task>",
    "",
    "<requirements>",
    "Favor primary sources when available.",
    "Call out uncertainty or source conflicts explicitly.",
    `Return at most ${MAX_SOURCES} sources and at most ${MAX_SEARCH_QUERIES} search queries.`,
    "</requirements>",
  ].join("\n");
}

export { createWebSearchRequest, executeWebSearchRequest };
