import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_SEARCH_QUERIES,
  MAX_SOURCES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  WEBSEARCH_MODELS,
  WEBSEARCH_PROVIDER,
  asRecord,
  type WebSearchDetails,
} from "./types.js";
import { buildDetails, formatResult } from "./parsing.js";
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
  signal: AbortSignal | undefined,
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
  const baseUrl = buildResponsesBaseUrl(model.baseUrl);
  const endpoint = `${baseUrl}/responses`;
  const timeout = createTimeoutSignal(request.timeoutMs, signal);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: buildHeaders(auth.apiKey, auth.headers),
      body: JSON.stringify(
        configureGroundedSearchPayload({
          model: request.modelId,
          instructions: buildSystemInstruction(),
          input: buildUserPrompt(request.query),
          stream: false,
          store: false,
        }),
      ),
      signal: timeout.signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(responseText || `Websearch request failed: ${response.status}`);
    }
    if (response.headers.get("content-type")?.includes("text/event-stream") === true) {
      return finalizeResponsesApiStreamText(responseText, request, endpoint, onUpdate);
    }
    return finalizeResponsesApiJsonText(responseText, request, endpoint);
  } finally {
    timeout.clear();
  }
}

function buildHeaders(
  apiKey: string,
  authHeaders: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...authHeaders,
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

function finalizeResponsesApiJsonText(
  responseText: string,
  request: {
    query: string;
    modelId: (typeof WEBSEARCH_MODELS)[number];
    timeoutMs: number;
    startedAt: number;
  },
  endpoint: string,
): { content: Array<{ type: "text"; text: string }>; details: WebSearchDetails } {
  const responseJson: unknown = JSON.parse(responseText);
  const text = extractResponsesText(responseJson).trim();
  return finalizeSearchText(text, request, endpoint);
}

function finalizeResponsesApiStreamText(
  responseText: string,
  request: {
    query: string;
    modelId: (typeof WEBSEARCH_MODELS)[number];
    timeoutMs: number;
    startedAt: number;
  },
  endpoint: string,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): { content: Array<{ type: "text"; text: string }>; details: WebSearchDetails } {
  let finalResponse: unknown;
  let streamedText = "";
  for (const event of parseResponsesStreamEvents(responseText)) {
    const eventRecord = asRecord(event);
    if (eventRecord?.type === "response.output_text.delta") {
      const delta = eventRecord.delta;
      if (typeof delta === "string") {
        streamedText += delta;
        const partialAnswer = extractStreamingAnswerText(streamedText);
        if (partialAnswer) {
          onUpdate?.({
            content: [{ type: "text", text: partialAnswer }],
            details: buildDetails(
              request.query,
              request.modelId,
              request.timeoutMs,
              endpoint,
              request.startedAt,
              { answer: partialAnswer, sources: [], searchQueries: [] },
            ),
          });
        }
      }
    }
    if (eventRecord?.type === "response.completed") {
      finalResponse = eventRecord.response;
    }
  }

  const text = (
    finalResponse === undefined ? streamedText : extractResponsesText(finalResponse)
  ).trim();
  return finalizeSearchText(text, request, endpoint);
}

function finalizeSearchText(
  text: string,
  request: {
    query: string;
    modelId: (typeof WEBSEARCH_MODELS)[number];
    timeoutMs: number;
    startedAt: number;
  },
  endpoint: string,
): { content: Array<{ type: "text"; text: string }>; details: WebSearchDetails } {
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

function parseResponsesStreamEvents(responseText: string): unknown[] {
  const events: unknown[] = [];
  for (const block of responseText.split(/\n\n+/)) {
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line.length > 0 && line !== "[DONE]");
    if (dataLines.length === 0) continue;
    events.push(JSON.parse(dataLines.join("\n")));
  }
  return events;
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

function configureGroundedSearchPayload(payload: unknown): unknown {
  const request = asRecord(payload);
  if (!request) return payload;
  request.tools = [{ googleSearch: {} }];
  delete request.reasoning;
  return request;
}

function createTimeoutSignal(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const abort = () => {
    controller.abort(parentSignal?.reason);
  };
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  if (parentSignal?.aborted === true) {
    abort();
  } else {
    parentSignal?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    },
  };
}

function buildResponsesBaseUrl(baseUrl: string | undefined): string {
  return (
    baseUrl
      ?.replace(/\/v1beta\/?$/, "")
      .replace(/\/v1\/?$/, "")
      .replace(/\/+$/, "") ?? ""
  ).concat("/v1");
}

function extractResponsesText(value: unknown): string {
  const response = asRecord(value);
  const outputText = response?.output_text;
  if (typeof outputText === "string") {
    return outputText;
  }
  const output = response?.output;
  if (!Array.isArray(output)) {
    return "";
  }
  return output
    .flatMap((item) => {
      const outputItem = asRecord(item);
      const content = outputItem?.content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((contentItem) => {
        const contentRecord = asRecord(contentItem);
        const text = contentRecord?.text;
        const contentOutputText = contentRecord?.output_text;
        if (typeof text === "string") return [text];
        if (typeof contentOutputText === "string") return [contentOutputText];
        return [];
      });
    })
    .join("\n");
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
