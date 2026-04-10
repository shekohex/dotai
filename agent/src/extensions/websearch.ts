import { stream, StringEnum } from "@mariozechner/pi-ai";
import { defineTool, getMarkdownTheme, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

const WEBSEARCH_PROVIDER = "gemini";
const WEBSEARCH_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"] as const;
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const THINKING_BUDGET = 1024;
const MAX_SOURCES = 8;
const MAX_SEARCH_QUERIES = 5;
const STREAM_PREVIEW_LINE_LIMIT = 5;
const TOOL_TEXT_PADDING_X = 0;
const TOOL_TEXT_PADDING_Y = 0;

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
    syncRenderState(context, context.isPartial);

    const phase = context.isError ? "error" : context.isPartial ? "pending" : "success";
    const status = phase === "error"
      ? theme.bold(theme.fg("error", "googled"))
      : phase === "success"
        ? theme.bold(theme.fg("dim", "googled"))
        : theme.bold(theme.fg("dim", "googling"));
    const query = typeof args.query === "string" && args.query.trim().length > 0 ? args.query.trim() : "...";

    return createTextComponent(
      context.lastComponent,
      `${status} ${theme.fg("muted", query)}${theme.fg("muted", ` (${resolveModel(args.model)} • ${formatDurationHuman(resolveTimeoutMs(args.timeoutMs))})`)}`,
    );
  },
  renderResult(result, { expanded, isPartial }, theme, context) {
    const state = syncRenderState(context, isPartial);
    const details = result.details as WebSearchDetails | undefined;
    const answer = (details?.answer ?? getTextContent(result.content)).trim();
    const durationMs = details?.durationMs ?? getElapsedMs(state);

    if (context.isError) {
      if (expanded) {
        const errorText = answer || "Web search failed.";
        return createTextComponent(
          context.lastComponent,
          `${theme.fg("error", "↳ ")}${theme.fg("error", errorText)}`,
        );
      }
      return createTextComponent(context.lastComponent, "");
    }

    if (isPartial) {
      const renderedText = renderToolOutput(answer, theme);
      const footer = durationMs !== undefined ? formatDurationHuman(durationMs) : "0s";
      return renderedText
        ? renderStreamingPreview(renderedText, theme, context.lastComponent, { expanded, footer })
        : createTextComponent(context.lastComponent, `${theme.fg("dim", "↳ ")}${theme.fg("muted", footer)}`);
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
        `${theme.fg("dim", "↳ ")}${summary}`,
      );
    }

    const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
    container.clear();
    container.addChild(new Markdown((details?.markdown ?? buildExpandedMarkdown(answer || "No answer returned.", details)).trim(), TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y, getMarkdownTheme()));
    container.addChild(new Spacer(1));
    container.addChild(new Text(`${theme.fg("dim", "↳ ")}${summary}`, TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y));
    return container;
  },
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
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

    const model = ctx.modelRegistry.find(WEBSEARCH_PROVIDER, modelId);
    if (!model) {
      throw new Error(`Gemini model ${modelId} is not available. Ensure the LiteLLM-backed provider \`${WEBSEARCH_PROVIDER}\` is loaded.`);
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(`Websearch auth failed: ${auth.error}`);
    }

    if (!auth.apiKey) {
      throw new Error(`No API key for ${model.provider}/${model.id}`);
    }

    const endpoint = `${model.baseUrl.replace(/\/$/, "")}/models/${model.id}:streamGenerateContent?alt=sse`;
    const searchStream = stream(
      model,
      {
        systemPrompt: buildSystemInstruction(),
        messages: [{ role: "user", content: buildUserPrompt(query), timestamp: Date.now() }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: mergeAbortSignals(signal, timeoutMs),
        onPayload: (payload) => configureGroundedSearchPayload(payload, model.reasoning),
      },
    );

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
        details: buildDetails(query, modelId, timeoutMs, endpoint, startedAt, {
          answer: partialAnswer,
          sources: [],
          searchQueries: [],
        }),
      });
    }

    const response = await searchStream.result();
    const text = getAssistantText(response.content).trim();

    if (response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? "Websearch request aborted");
    }

    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || text || "Websearch failed");
    }

    const result = parseSearchResponseText(text);
    if (!result.answer) {
      throw new Error("Websearch returned no answer");
    }

    return {
      content: [{ type: "text", text: formatResult(result) }],
      details: buildDetails(query, modelId, timeoutMs, endpoint, startedAt, result),
    };
  },
});

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool(webSearchTool);
}

function resolveModel(model: (typeof WEBSEARCH_MODELS)[number] | undefined): (typeof WEBSEARCH_MODELS)[number] {
  return model ?? DEFAULT_MODEL;
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(timeoutMs as number)));
}

function mergeAbortSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function configureGroundedSearchPayload(payload: unknown, includeThinking: boolean): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const request = { ...(payload as Record<string, unknown>) };
  const config = request.config && typeof request.config === "object"
    ? { ...(request.config as Record<string, unknown>) }
    : {};

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

function syncRenderState(
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
): WebSearchRenderState {
  const state = context.state as WebSearchRenderState;

  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }

  if (isPartial && state.startedAt !== undefined && !state.interval) {
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
  return state.startedAt === undefined ? undefined : (state.endedAt ?? Date.now()) - state.startedAt;
}

function emptyResult(): SearchResult {
  return { answer: "", sources: [], searchQueries: [] };
}

function renderToolOutput(text: string, theme: { fg: (color: "toolOutput", text: string) => string }): string {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");
}

function renderStreamingPreview(
  renderedText: string,
  theme: { fg: (color: "dim" | "muted" | "toolOutput", text: string) => string },
  lastComponent: unknown,
  options: { expanded: boolean; footer?: string },
): Text {
  const lines = renderedText.split("\n").filter((line) => line.length > 0);

  if (options.expanded) {
    const footer = options.footer ? `${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}` : "";
    return createTextComponent(lastComponent, [renderedText, footer].filter(Boolean).join("\n"));
  }

  const visibleLines = lines.slice(-STREAM_PREVIEW_LINE_LIMIT);
  const blocks: string[] = [];

  if (lines.length > visibleLines.length) {
    blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", `... (${lines.length - visibleLines.length} earlier lines)`)}`);
  }

  if (visibleLines.length > 0) {
    blocks.push(visibleLines.join("\n"));
  }

  if (options.footer) {
    blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", `${summarizeLineCount(lines.length)} so far (${options.footer})`)}`);
  }

  return createTextComponent(lastComponent, blocks.join("\n"));
}

function summarizeLineCount(lineCount: number): string {
  return `${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

function createTextComponent(lastComponent: unknown, text: string): Text {
  const component = lastComponent instanceof Text ? lastComponent : new Text("", TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y);
  component.setText(text);
  return component;
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
    markdown: buildExpandedMarkdown(result.answer.trim() || "No answer returned.", result),
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

function parseSearchResponseText(text: string): SearchResult {
  const normalized = text.trim();
  if (!normalized) {
    return emptyResult();
  }

  const structured = parseStructuredSearchJson(normalized);
  return structured ?? { answer: stripWrappingCodeFence(normalized), sources: [], searchQueries: [] };
}

function extractStreamingAnswerText(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("{") && !normalized.includes("\"answer\"")) {
    return "";
  }

  const answerValue = extractPartialJsonStringValue(normalized, "answer");
  if (answerValue !== undefined) {
    return answerValue.trim();
  }

  return normalized.startsWith("{") ? "" : stripWrappingCodeFence(normalized);
}

function getTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n");
}

function getAssistantText(content: Array<{ type: string; text?: string } | { type: string; thinking?: string }>): string {
  return content
    .flatMap((item) => (item.type === "text" && "text" in item && typeof item.text === "string" ? [item.text] : []))
    .join("\n");
}

function formatDurationHuman(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function buildExpandedMarkdown(
  answer: string,
  details: Pick<WebSearchDetails, "sources" | "searchQueries"> | Pick<SearchResult, "sources" | "searchQueries"> | undefined,
): string {
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

function parseStructuredSearchJson(text: string): SearchResult | undefined {
  const candidateJsons = extractTopLevelJsonObjects(stripWrappingCodeFence(text));
  if (candidateJsons.length === 0) {
    return undefined;
  }

  const sources = new Map<string, WebSearchSource>();
  const searchQueries = new Set<string>();
  let answer = "";

  try {
    for (const candidateJson of candidateJsons) {
      const parsed = JSON.parse(candidateJson) as StructuredSearchResult;
      if (parsed.answer?.trim()) {
        answer = parsed.answer.trim();
      }
      for (const source of parsed.sources ?? []) {
        addSource(sources, source.title, source.url);
      }
      for (const searchQuery of parsed.searchQueries ?? []) {
        addSearchQuery(searchQueries, searchQuery);
      }
    }
  } catch {
    return undefined;
  }

  if (!answer && sources.size === 0 && searchQueries.size === 0) {
    return undefined;
  }

  return {
    answer,
    sources: [...sources.values()],
    searchQueries: [...searchQueries],
  };
}

function extractTopLevelJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function stripWrappingCodeFence(text: string): string {
  return text.replace(/^```\w*\n?|```$/g, "").trim();
}

function addSource(sources: Map<string, WebSearchSource>, title: string | undefined, url: string | undefined): void {
  const normalizedTitle = title?.trim();
  const normalizedUrl = url?.trim();
  if (!normalizedTitle || !normalizedUrl || sources.has(normalizedUrl) || sources.size >= MAX_SOURCES) {
    return;
  }

  sources.set(normalizedUrl, { title: normalizedTitle, url: normalizedUrl });
}

function addSearchQuery(searchQueries: Set<string>, searchQuery: string | undefined): void {
  const normalized = searchQuery?.trim();
  if (!normalized || searchQueries.has(normalized) || searchQueries.size >= MAX_SEARCH_QUERIES) {
    return;
  }

  searchQueries.add(normalized);
}

function extractPartialJsonStringValue(text: string, key: string): string | undefined {
  const match = new RegExp(`"${escapeRegex(key)}"\\s*:\\s*"`, "m").exec(text);
  if (!match) {
    return undefined;
  }

  let index = match.index + match[0].length;
  let value = "";

  while (index < text.length) {
    const char = text[index];
    if (char === "\"") {
      return value;
    }
    if (char !== "\\") {
      value += char;
      index += 1;
      continue;
    }

    const next = text[index + 1];
    if (next === undefined) {
      return value;
    }
    if (next === "u") {
      const hex = text.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        return value;
      }
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }

    value += decodeJsonEscape(next);
    index += 2;
  }

  return value;
}

function decodeJsonEscape(value: string): string {
  switch (value) {
    case "\"": return "\"";
    case "\\": return "\\";
    case "/": return "/";
    case "b": return "\b";
    case "f": return "\f";
    case "n": return "\n";
    case "r": return "\r";
    case "t": return "\t";
    default: return value;
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/([\\\[\]])/g, "\\$1");
}

function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}
