import { stream, StringEnum } from "@mariozechner/pi-ai";
import { defineTool, getMarkdownTheme, keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
const COLLAPSED_ERROR_MAX_LINES = 8;
const COLLAPSED_ERROR_MAX_CHARS = 1200;
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

type SearchSection = "answer" | "sources" | "queries";

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
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
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

    const searchModel = ctx.modelRegistry.find(WEBSEARCH_PROVIDER, model);
    if (!searchModel) {
      throw new Error(`Gemini model ${model} is not available. Ensure the LiteLLM-backed \`${WEBSEARCH_PROVIDER}\` provider is loaded.`);
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(searchModel);
    if (!auth.ok) {
      throw new Error(`Websearch auth failed: ${auth.error}`);
    }

    if (!auth.apiKey) {
      throw new Error(`No API key for ${searchModel.provider}/${searchModel.id}`);
    }

    const endpoint = `${searchModel.baseUrl?.replace(/\/$/, "") ?? `${searchModel.provider}/${searchModel.id}`}/models/${searchModel.id}:streamGenerateContent?alt=sse`;
    const searchStream = stream(
      searchModel,
      {
        systemPrompt: buildSystemInstruction(),
        messages: [{ role: "user", content: buildUserPrompt(query), timestamp: Date.now() }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: mergeAbortSignals(signal, timeoutMs),
        onPayload: (payload) => configureGroundedSearchPayload(payload, searchModel.reasoning),
      },
    );

    let lastPartialAnswer = "";

    for await (const event of searchStream) {
      if (event.type !== "text_start" && event.type !== "text_delta" && event.type !== "text_end") {
        continue;
      }

      const partialText = getAssistantText(event.partial.content).trim();
      const partialAnswer = extractStreamingAnswerText(partialText);
      if (!partialAnswer || partialAnswer === lastPartialAnswer) {
        continue;
      }

      lastPartialAnswer = partialAnswer;
      onUpdate?.({
        content: [{ type: "text", text: partialAnswer }],
        details: buildDetails(query, model, timeoutMs, endpoint, startedAt, {
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

function parseSearchResponseText(text: string): SearchResult {
  const normalized = text.trim();
  if (!normalized) {
    return { answer: "", sources: [], searchQueries: [] };
  }

  const structured = parseStructuredSearchJson(normalized);
  if (structured) {
    return structured;
  }

  return parseSectionedSearchText(stripWrappingCodeFence(normalized));
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

  if (normalized.startsWith("{")) {
    return "";
  }

  return parseSectionedSearchText(stripWrappingCodeFence(normalized)).answer;
}

function extractPartialJsonStringValue(text: string, key: string): string | undefined {
  const pattern = new RegExp(`"${escapeRegex(key)}"\\s*:\\s*"`, "m");
  const match = pattern.exec(text);
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
    case "\"":
      return "\"";
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return value;
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseStructuredSearchJson(text: string): SearchResult | undefined {
  const normalized = stripWrappingCodeFence(text);
  const objects = extractTopLevelJsonObjects(normalized);
  const candidateJsons = objects.length > 0 ? objects : [normalized];
  if (candidateJsons.length === 0) {
    return undefined;
  }

  try {
    const sources = new Map<string, WebSearchSource>();
    const searchQueries = new Set<string>();
    let answer = "";

    for (const candidateJson of candidateJsons) {
      const trimmed = candidateJson.trim();
      if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
        continue;
      }

      const parsed = JSON.parse(trimmed) as StructuredSearchResult;

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

    if (!answer && sources.size === 0 && searchQueries.size === 0) {
      return undefined;
    }

    return {
      answer,
      sources: [...sources.values()],
      searchQueries: [...searchQueries],
    };
  } catch {
    return undefined;
  }
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
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === "\"") {
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

    if (char !== "}") {
      continue;
    }

    if (depth === 0) {
      continue;
    }

    depth -= 1;
    if (depth === 0 && start !== -1) {
      objects.push(text.slice(start, index + 1));
      start = -1;
    }
  }

  return objects;
}

function parseSectionedSearchText(text: string): SearchResult {
  const lines = text.split("\n");
  const answerLines: string[] = [];
  const sources = new Map<string, WebSearchSource>();
  const searchQueries = new Set<string>();
  let section: SearchSection = "answer";
  let pendingSourceTitle: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    const normalizedHeading = trimmed.replace(/^[#*\s]+|[*\s]+$/g, "").trim();

    if (/^sources:?$/i.test(normalizedHeading)) {
      section = "sources";
      pendingSourceTitle = undefined;
      continue;
    }

    if (/^search\s+queries:?$/i.test(normalizedHeading)) {
      section = "queries";
      pendingSourceTitle = undefined;
      continue;
    }

    if (section === "sources") {
      const standaloneUrl = parseStandaloneUrl(trimmed);
      if (standaloneUrl && pendingSourceTitle) {
        addSource(sources, pendingSourceTitle, standaloneUrl);
        pendingSourceTitle = undefined;
        continue;
      }

      const source = parseSourceLine(trimmed);
      if (source) {
        addSource(sources, source.title, source.url);
        pendingSourceTitle = undefined;
        continue;
      }

      const sourceTitle = parseSourceTitleLine(trimmed);
      if (sourceTitle) {
        pendingSourceTitle = sourceTitle;
        continue;
      }
    }

    if (section === "queries") {
      const searchQuery = parseSearchQueryLine(trimmed);
      if (searchQuery) {
        addSearchQuery(searchQueries, searchQuery);
        continue;
      }
    }

    if (section === "answer") {
      answerLines.push(line);
    }
  }

  return {
    answer: answerLines.join("\n").trim() || text.trim(),
    sources: [...sources.values()],
    searchQueries: [...searchQueries],
  };
}

function stripWrappingCodeFence(text: string): string {
  return text.replace(/^```\w*\n?|```$/g, "").trim();
}

function parseSourceLine(line: string): WebSearchSource | undefined {
  if (!line) {
    return undefined;
  }

  const normalized = line.replace(/^[-*]\s*/, "").trim();

  const markdownAngleMatch = /^\[(.+?)\]\(<(.+?)>\)$/.exec(normalized);
  if (markdownAngleMatch) {
    return { title: markdownAngleMatch[1].trim(), url: markdownAngleMatch[2].trim() };
  }

  const markdownMatch = /^\[(.+?)\]\((https?:\/\/[^\s)]+)\)$/.exec(normalized);
  if (markdownMatch) {
    return { title: markdownMatch[1].trim(), url: markdownMatch[2].trim() };
  }

  const dashMatch = /^(.+?)\s+[—-]\s+(https?:\/\/\S+)$/.exec(normalized);
  if (dashMatch) {
    return { title: dashMatch[1].trim(), url: dashMatch[2].trim() };
  }

  const rawUrlMatch = /^(https?:\/\/\S+)$/.exec(normalized);
  if (rawUrlMatch) {
    return { title: rawUrlMatch[1].trim(), url: rawUrlMatch[1].trim() };
  }

  return undefined;
}

function parseSourceTitleLine(line: string): string | undefined {
  const normalized = line.replace(/^[-*]\s*/, "").trim();
  if (!normalized || normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return undefined;
  }

  return normalized.replace(/^\*\*|\*\*$/g, "").trim();
}

function parseStandaloneUrl(line: string): string | undefined {
  return /^https?:\/\/\S+$/.test(line) ? line : undefined;
}

function parseSearchQueryLine(line: string): string | undefined {
  const match = /^[-*]\s*(.+)$/.exec(line);
  return match?.[1].trim() || undefined;
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

function getAssistantText(content: Array<{ type: string; text?: string } | { type: string; thinking?: string }>): string {
  return content
    .flatMap((item) => (item.type === "text" && "text" in item && typeof item.text === "string" ? [item.text] : []))
    .join("\n");
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
