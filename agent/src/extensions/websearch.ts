import { StringEnum } from "@mariozechner/pi-ai";
import { defineTool, getMarkdownTheme, keyHint, type AgentToolUpdateCallback, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { LITELLM_API_KEY_ENV, resolveLiteLLMApiKey, resolveLiteLLMState } from "./litellm.js";

const WEBSEARCH_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"] as const;
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const THINKING_BUDGET = 1024;
const MAX_SOURCES = 8;
const MAX_SEARCH_QUERIES = 5;
const COLLAPSED_ERROR_MAX_LINES = 8;
const COLLAPSED_ERROR_MAX_CHARS = 1200;
const STREAM_PREVIEW_LINE_LIMIT = 5;
const TOOL_TEXT_PADDING_X = 0;
const TOOL_TEXT_PADDING_Y = 0;

type GroundingChunk = {
  web?: {
    title?: string;
    uri?: string;
  };
};

type GroundingMetadata = {
  groundingChunks?: GroundingChunk[];
  webSearchQueries?: string[];
};

type GeminiCandidate = {
  content?: {
    parts?: Array<{ text?: string }>;
  };
  groundingMetadata?: GroundingMetadata;
};

type GeminiResponse = {
  candidates?: GeminiCandidate[];
  error?: {
    message?: string;
  };
};

type StructuredSearchResult = {
  answer?: string;
  sources?: Array<{ title?: string; url?: string }>;
  searchQueries?: string[];
};

type WebSearchSource = {
  title: string;
  url: string;
};

type SearchResult = {
  answer: string;
  sources: WebSearchSource[];
  searchQueries: string[];
};

type SearchAccumulator = {
  answer: string;
  sources: Map<string, WebSearchSource>;
  searchQueries: Set<string>;
};

type WebSearchDetails = {
  query: string;
  model: string;
  timeoutMs: number;
  durationMs: number;
  endpoint: string;
  answer: string;
  markdown: string;
  searchQueries: string[];
  sources: WebSearchSource[];
};

type WebSearchRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
};

export const webSearchTool = defineTool({
  name: "websearch",
  label: "google",
  description: "Search the web with Google Search grounding via Gemini and return an answer with sources.",
  promptSnippet: "Search the live web with Google grounding when the task needs fresh or external information",
  promptGuidelines: [
    "Use this tool when the task needs fresh web data, release notes, official docs, or verification against external sources.",
    "Prefer primary sources and use returned citations in the final answer when the user asks for evidence or references.",
    "Use this tool instead of guessing whenever correctness depends on current or externally verifiable information.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "Search query or question to answer from the web" }),
    model: Type.Optional(
      StringEnum(WEBSEARCH_MODELS, {
        description: `Gemini model for grounded search. Default: ${DEFAULT_MODEL}`,
        default: DEFAULT_MODEL,
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        minimum: MIN_TIMEOUT_MS,
        maximum: MAX_TIMEOUT_MS,
        description: `Request timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}`,
      }),
    ),
  }),
  renderCall(args, theme, context) {
    const phase = context.isError ? "error" : context.isPartial ? "pending" : "success";
    const status = phase === "error"
      ? theme.fg("error", "✗ googled")
      : phase === "success"
        ? theme.fg("muted", "✓ googled")
        : theme.fg("dim", "… googling");
    const query = typeof args.query === "string" && args.query.trim().length > 0 ? args.query.trim() : "...";
    const model = normalizeModel(args.model);
    const timeoutMs = clampTimeout(args.timeoutMs);

    syncRenderState(context, context.isPartial);

    return createTextComponent(
      context.lastComponent,
      `${status} ${theme.fg("accent", query)}${theme.fg("muted", ` (${model} • ${formatDurationHuman(timeoutMs)})`)}`,
    );
  },
  renderResult(result, { expanded, isPartial }, theme, context) {
    const state = syncRenderState(context, isPartial);
    const details = result.details as WebSearchDetails | undefined;
    const answer = (details?.answer ?? getTextContent(result.content)).trim();
    const durationMs = details?.durationMs ?? getElapsedMs(state);

    if (context.isError) {
      const errorText = answer || "Web search failed.";
      const preview = truncateForDisplay(errorText, COLLAPSED_ERROR_MAX_LINES, COLLAPSED_ERROR_MAX_CHARS);
      const message = expanded ? errorText : preview.text || errorText;
      return createTextComponent(context.lastComponent, `${theme.fg("error", "↳ ")}${theme.fg("error", message)}`);
    }

    if (isPartial) {
      const streamedText = styleToolOutput(answer, theme);
      const footer = durationMs !== undefined ? formatDurationHuman(durationMs) : "0s";

      if (!streamedText) {
        return createTextComponent(
          context.lastComponent,
          `${theme.fg("dim", "↳ ")}${theme.fg("muted", footer)}`,
        );
      }

      return renderStreamingPreview(streamedText, theme, context.lastComponent, {
        expanded,
        footer,
        expandHint: !expanded,
        tailLines: STREAM_PREVIEW_LINE_LIMIT,
      });
    }

    const groundedResultCount = details?.sources.length ?? 0;
    const summary = [
      theme.fg("muted", answer ? "answered" : "no response"),
      theme.fg("muted", `${groundedResultCount} grounded result${groundedResultCount === 1 ? "" : "s"}`),
      durationMs !== undefined ? theme.fg("muted", `took ${formatDurationHuman(durationMs)}`) : "",
    ].filter(Boolean).join(`${theme.fg("muted", " · ")}`);

    if (!expanded) {
      return createTextComponent(
        context.lastComponent,
        `${theme.fg("dim", "↳ ")}${summary}${theme.fg("muted", " · ")}${keyHint("app.tools.expand", "to expand")}`,
      );
    }

    const markdown = (details?.markdown ?? buildExpandedMarkdown(answer || "No answer returned.", details)).trim();
    const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
    container.clear();
    container.addChild(new Markdown(markdown, TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y, getMarkdownTheme()));
    container.addChild(new Spacer(1));
    container.addChild(new Text(`${theme.fg("dim", "↳ ")}${summary}`, TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y));
    return container;
  },
  async execute(_toolCallId, params, signal, onUpdate) {
    const query = params.query.trim();
    if (!query) {
      throw new Error("websearch query is empty");
    }

    const model = normalizeModel(params.model);
    const timeoutMs = clampTimeout(params.timeoutMs);
    const startedAt = Date.now();

    onUpdate?.({
      content: [],
      details: {
        query,
        model,
        timeoutMs,
        durationMs: 0,
        endpoint: "",
        answer: "",
        markdown: "",
        searchQueries: [],
        sources: [],
      } satisfies WebSearchDetails,
    });

    const state = await resolveLiteLLMState();
    const apiKey = (await resolveLiteLLMApiKey()) ?? process.env[LITELLM_API_KEY_ENV];

    if (!state.origin) {
      throw new Error(`LiteLLM gateway unavailable${state.error ? `: ${state.error}` : ""}`);
    }

    if (!apiKey) {
      throw new Error(`LiteLLM API key not configured. Authenticate provider "litellm" or set ${LITELLM_API_KEY_ENV}.`);
    }

    const requestBody = buildRequestBody(query);
    const streamEndpoint = `${state.origin}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
    const streamResponse = await fetch(streamEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
      signal: mergeAbortSignals(signal, timeoutMs),
    });

    if (streamResponse.ok) {
      const streamed = await readStreamingSearchResponse(streamResponse, {
        query,
        model,
        timeoutMs,
        endpoint: streamEndpoint,
        startedAt,
        onUpdate,
      });

      if (streamed.answer) {
        return {
          content: [{ type: "text", text: formatResult(streamed) }],
          details: buildDetails(query, model, timeoutMs, streamEndpoint, startedAt, streamed),
        };
      }
    }

    const endpoint = `${state.origin}/v1beta/models/${model}:generateContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
      signal: mergeAbortSignals(signal, timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const snippet = errorText.length > 2000 ? `${errorText.slice(0, 2000)}...` : errorText;
      throw new Error(`LiteLLM websearch failed: ${response.status} ${response.statusText}${snippet ? `\n${snippet}` : ""}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const result = parseSearchResponse(data);
    if (!result.answer) {
      throw new Error(data.error?.message ?? "LiteLLM websearch returned no answer");
    }

    return {
      content: [{ type: "text", text: formatResult(result) }],
      details: buildDetails(query, model, timeoutMs, endpoint, startedAt, result),
    };
  },
});

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool(webSearchTool);
}

function normalizeModel(model: (typeof WEBSEARCH_MODELS)[number] | undefined): (typeof WEBSEARCH_MODELS)[number] {
  return model ?? DEFAULT_MODEL;
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(timeoutMs as number)));
}

function mergeAbortSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function buildRequestBody(query: string) {
  return {
    systemInstruction: {
      parts: [{ text: buildSystemInstruction() }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: buildUserPrompt(query) }],
      },
    ],
    tools: [{ googleSearch: {} }],
    generationConfig: {
      thinkingConfig: {
        thinkingBudget: THINKING_BUDGET,
        includeThoughts: false,
      },
    },
  };
}

async function readStreamingSearchResponse(
  response: Response,
  input: {
    query: string;
    model: string;
    timeoutMs: number;
    endpoint: string;
    startedAt: number;
    onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  },
): Promise<SearchResult> {
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.body) {
    return { answer: "", sources: [], searchQueries: [] };
  }

  if (!contentType.includes("text/event-stream")) {
    const text = await response.text();
    return parseStreamingFallbackBody(text);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  const aggregate = createSearchAccumulator();

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = consumeSseEvents(buffer);
    buffer = events.rest;

    for (const eventText of events.events) {
      const payload = parseSseDataPayload(eventText);
      if (!payload) {
        continue;
      }

      const chunks = Array.isArray(payload) ? payload : [payload];
      let didChange = false;
      for (const chunk of chunks) {
        didChange = mergeSearchChunk(aggregate, chunk) || didChange;
      }

      if (didChange) {
        emitStreamingUpdate(input, aggregate);
      }
    }
  }

  const finalPayload = buffer.trim();
  if (finalPayload) {
    const payload = parseSseDataPayload(finalPayload);
    if (payload) {
      const chunks = Array.isArray(payload) ? payload : [payload];
      for (const chunk of chunks) {
        mergeSearchChunk(aggregate, chunk);
      }
    }
  }

  emitStreamingUpdate(input, aggregate);

  return finalizeSearchAccumulator(aggregate);
}

function emitStreamingUpdate(
  input: {
    query: string;
    model: string;
    timeoutMs: number;
    endpoint: string;
    startedAt: number;
    onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  },
  aggregate: SearchAccumulator,
): void {
  if (!input.onUpdate) {
    return;
  }

  const result = finalizeSearchAccumulator(aggregate);
  input.onUpdate({
    content: result.answer ? [{ type: "text", text: result.answer }] : [],
    details: buildDetails(input.query, input.model, input.timeoutMs, input.endpoint, input.startedAt, result),
  });
}

function syncRenderState(
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
): WebSearchRenderState {
  const state = context.state as WebSearchRenderState;

  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }

  if (state.startedAt !== undefined && isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1000);
    state.interval.unref?.();
  }

  if (!isPartial && state.startedAt !== undefined) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  return state;
}

function getElapsedMs(state: WebSearchRenderState): number | undefined {
  if (state.startedAt === undefined) {
    return undefined;
  }

  return (state.endedAt ?? Date.now()) - state.startedAt;
}

function createSearchAccumulator(): SearchAccumulator {
  return {
    answer: "",
    sources: new Map<string, WebSearchSource>(),
    searchQueries: new Set<string>(),
  };
}

function finalizeSearchAccumulator(accumulator: SearchAccumulator): SearchResult {
  return {
    answer: accumulator.answer.trim(),
    sources: [...accumulator.sources.values()],
    searchQueries: [...accumulator.searchQueries],
  };
}

function mergeSearchChunk(accumulator: SearchAccumulator, data: GeminiResponse): boolean {
  const result = parseSearchResponse(data);
  let changed = false;

  if (result.answer) {
    const nextAnswer = mergeStreamingAnswer(accumulator.answer, result.answer);
    if (nextAnswer !== accumulator.answer) {
      accumulator.answer = nextAnswer;
      changed = true;
    }
  }

  for (const source of result.sources) {
    if (accumulator.sources.has(source.url) || accumulator.sources.size >= MAX_SOURCES) {
      continue;
    }

    accumulator.sources.set(source.url, source);
    changed = true;
  }

  for (const searchQuery of result.searchQueries) {
    if (accumulator.searchQueries.has(searchQuery) || accumulator.searchQueries.size >= MAX_SEARCH_QUERIES) {
      continue;
    }

    accumulator.searchQueries.add(searchQuery);
    changed = true;
  }

  return changed;
}

function mergeStreamingAnswer(currentAnswer: string, chunkAnswer: string): string {
  const current = currentAnswer.trimEnd();
  const chunk = chunkAnswer.trim();

  if (!chunk) {
    return currentAnswer;
  }

  if (!current) {
    return chunk;
  }

  if (chunk === current || current.endsWith(chunk)) {
    return current;
  }

  if (chunk.startsWith(current)) {
    return chunk;
  }

  if (current.startsWith(chunk)) {
    return current;
  }

  return `${current}\n${chunk}`;
}

function buildSystemInstruction(): string {
  return [
    "<role>",
    "You are a super fast and smart Google Search research agent.",
    "You are precise, analytical, and persistent.",
    "</role>",
    "",
    "<instructions>",
    "1. Plan: break the query into focused sub-questions.",
    "2. Execute: search broadly, cross-check claims, and use multiple sources.",
    '3. Cite: every specific claim must include a source link; if none, say "uncited".',
    "4. Validate: resolve conflicts or call them out explicitly.",
    "5. Format: return a concise technical answer in Markdown prose.",
    "</instructions>",
    "",
    "<constraints>",
    "- Verbosity: High",
    "- Tone: Technical",
    "- No fabricated facts or URLs",
    "- Do not reveal planning, analysis, or tool-use reasoning",
    "- Do not include a Sources or Search queries section; the tool renders that separately",
    "</constraints>",
  ].join("\n");
}

function buildUserPrompt(query: string): string {
  return [
    "<task>",
    `Search the web and answer this query: ${query}`,
    "</task>",
    "",
    "<requirements>",
    "Favor official and primary sources when available.",
    "Call out uncertainty or source conflicts explicitly.",
    "</requirements>",
    "",
    "<final_instruction>",
    "Use deeper reasoning internally, but output only the final answer body in Markdown.",
    "</final_instruction>",
  ].join("\n");
}

function parseSearchResponse(data: GeminiResponse): SearchResult {
  const sources = new Map<string, WebSearchSource>();
  const searchQueries = new Set<string>();
  let answer = "";

  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts
    ?.map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();

  if (text) {
    const jsonPayload = text.startsWith("```") ? text.replace(/^```\w*\n?|```$/g, "").trim() : text;
    const match = /\{[\s\S]*\}/.exec(jsonPayload);
    const candidateJson = match ? match[0] : jsonPayload;

    if (candidateJson.startsWith("{") && candidateJson.endsWith("}")) {
      try {
        const structured = JSON.parse(candidateJson) as StructuredSearchResult;
        if (structured.answer?.trim()) {
          answer = structured.answer.trim();
        }
        for (const source of structured.sources ?? []) {
          const title = source.title?.trim();
          const url = source.url?.trim();
          if (!title || !url || sources.has(url)) {
            continue;
          }
          sources.set(url, { title, url });
          if (sources.size >= MAX_SOURCES) {
            break;
          }
        }
        for (const searchQuery of structured.searchQueries ?? []) {
          const normalized = searchQuery.trim();
          if (!normalized) {
            continue;
          }
          searchQueries.add(normalized);
          if (searchQueries.size >= MAX_SEARCH_QUERIES) {
            break;
          }
        }
      } catch {
        answer = text;
      }
    } else {
      answer = text;
    }
  }

  for (const metadata of candidate?.groundingMetadata ? [candidate.groundingMetadata] : []) {
    for (const chunk of metadata.groundingChunks ?? []) {
      const title = chunk.web?.title?.trim();
      const url = chunk.web?.uri?.trim();
      if (!title || !url || sources.has(url)) {
        continue;
      }
      sources.set(url, { title, url });
      if (sources.size >= MAX_SOURCES) {
        break;
      }
    }

    for (const searchQuery of metadata.webSearchQueries ?? []) {
      const normalized = searchQuery.trim();
      if (!normalized) {
        continue;
      }
      searchQueries.add(normalized);
      if (searchQueries.size >= MAX_SEARCH_QUERIES) {
        break;
      }
    }
  }

  return {
    answer,
    sources: [...sources.values()],
    searchQueries: [...searchQueries],
  };
}

function consumeSseEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const events: string[] = [];
  let start = 0;

  while (true) {
    const boundary = normalized.indexOf("\n\n", start);
    if (boundary === -1) {
      break;
    }

    events.push(normalized.slice(start, boundary));
    start = boundary + 2;
  }

  return {
    events,
    rest: normalized.slice(start),
  };
}

function parseSseDataPayload(eventText: string): GeminiResponse | GeminiResponse[] | undefined {
  const data = eventText
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();

  if (!data || data === "[DONE]") {
    return undefined;
  }

  try {
    return JSON.parse(data) as GeminiResponse | GeminiResponse[];
  } catch {
    return undefined;
  }
}

function parseStreamingFallbackBody(text: string): SearchResult {
  const normalized = text.trim();
  if (!normalized) {
    return { answer: "", sources: [], searchQueries: [] };
  }

  try {
    const parsed = JSON.parse(normalized) as GeminiResponse | GeminiResponse[];
    if (Array.isArray(parsed)) {
      const accumulator = createSearchAccumulator();
      for (const item of parsed) {
        mergeSearchChunk(accumulator, item);
      }
      return finalizeSearchAccumulator(accumulator);
    }

    return parseSearchResponse(parsed);
  } catch {
    return { answer: normalized, sources: [], searchQueries: [] };
  }
}

function buildDetails(
  query: string,
  model: string,
  timeoutMs: number,
  endpoint: string,
  startedAt: number,
  result: SearchResult,
): WebSearchDetails {
  return {
    query,
    model,
    timeoutMs,
    durationMs: Math.max(0, Date.now() - startedAt),
    endpoint,
    answer: result.answer,
    markdown: formatMarkdownResult(result),
    searchQueries: result.searchQueries,
    sources: result.sources,
  };
}

function formatResult(result: SearchResult): string {
  const lines = [result.answer.trim() || "No answer returned."];

  if (result.sources.length > 0) {
    lines.push("", "Sources:");
    for (const source of result.sources) {
      lines.push(`- ${source.title} — ${source.url}`);
    }
  }

  if (result.searchQueries.length > 0) {
    lines.push("", "Search queries:");
    for (const searchQuery of result.searchQueries) {
      lines.push(`- ${searchQuery}`);
    }
  }

  return lines.join("\n");
}

function formatMarkdownResult(result: SearchResult): string {
  return buildExpandedMarkdown(result.answer.trim() || "No answer returned.", {
    searchQueries: result.searchQueries,
    sources: result.sources,
  });
}

function getTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n");
}

function formatDurationHuman(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function summarizeLineCount(lineCount: number): string {
  return `${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

function styleToolOutput(text: string, theme: { fg: (color: "toolOutput", text: string) => string }): string {
  if (!text) {
    return "";
  }

  return text
    .split("\n")
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");
}

function renderStreamingPreview(
  renderedText: string,
  theme: {
    fg: (color: "dim" | "muted" | "toolOutput", text: string) => string;
  },
  lastComponent: unknown,
  options: {
    expanded: boolean;
    footer?: string;
    expandHint?: boolean;
    tailLines?: number;
  },
): Text {
  const lines = renderedText.split("\n").filter((line) => line.length > 0);
  const tailSize = options.tailLines ?? STREAM_PREVIEW_LINE_LIMIT;

  if (options.expanded) {
    const footer = options.footer ? `${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}` : "";
    return createTextComponent(lastComponent, [renderedText, footer].filter(Boolean).join("\n"));
  }

  const visibleLines = lines.slice(-tailSize);
  const earlierCount = Math.max(lines.length - visibleLines.length, 0);
  const blocks: string[] = [];

  if (earlierCount > 0) {
    blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", `... (${earlierCount} earlier lines)`)}`);
  }

  if (visibleLines.length > 0) {
    blocks.push(visibleLines.join("\n"));
  }

  if (options.footer) {
    blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", `${summarizeLineCount(lines.length)} so far (${options.footer})`)}`);
  }

  if (options.expandHint) {
    blocks.push(`${theme.fg("dim", "↳ ")}${keyHint("app.tools.expand", "to expand")}`);
  }

  return createTextComponent(lastComponent, blocks.join("\n"));
}

function truncateForDisplay(text: string, maxLines: number, maxChars: number): { text: string; truncated: boolean } {
  const normalized = text.trim();
  if (!normalized) {
    return { text: "", truncated: false };
  }

  const lines = normalized.split("\n");
  const limitedLines = lines.slice(0, maxLines);
  let truncated = lines.length > maxLines;
  let output = limitedLines.join("\n");

  if (output.length > maxChars) {
    output = `${output.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
    truncated = true;
  } else if (truncated) {
    output = `${output.trimEnd()}\n…`;
  }

  return { text: output, truncated };
}

function buildExpandedMarkdown(answer: string, details: Pick<WebSearchDetails, "sources" | "searchQueries"> | undefined): string {
  const lines = [answer.trim() || "No answer returned."];

  if (details?.sources.length) {
    lines.push("", "## Sources");
    for (const source of details.sources) {
      lines.push(`- [${escapeMarkdownLinkText(source.title)}](<${source.url}>)`);
    }
  }

  if (details?.searchQueries.length) {
    lines.push("", "## Search queries");
    for (const searchQuery of details.searchQueries) {
      lines.push(`- ${escapeMarkdownText(searchQuery)}`);
    }
  }

  return lines.join("\n").trim();
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/([\\\[\]])/g, "\\$1");
}

function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function createTextComponent(lastComponent: unknown, text: string): Text {
  const component = lastComponent instanceof Text ? lastComponent : new Text("", TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y);
  component.setText(text);
  return component;
}
