import { StringEnum } from "@mariozechner/pi-ai";
import { defineTool, getMarkdownTheme, keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
const COLLAPSED_MAX_LINES = 6;
const COLLAPSED_MAX_CHARS = 900;
const COLLAPSED_ERROR_MAX_LINES = 8;
const COLLAPSED_ERROR_MAX_CHARS = 1200;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

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

type WebSearchDetails = {
  query: string;
  model: string;
  endpoint: string;
  answer: string;
  markdown: string;
  searchQueries: string[];
  sources: WebSearchSource[];
};

export const webSearchTool = defineTool({
  name: "websearch",
  label: "Web Search",
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
  renderCall(args, theme) {
    let text = theme.fg("toolTitle", theme.bold("⌕ web "));
    text += theme.fg("accent", args.query);

    const meta: string[] = [];
    if (args.model) {
      meta.push(args.model);
    }
    if (args.timeoutMs) {
      meta.push(`${args.timeoutMs}ms`);
    }
    if (meta.length > 0) {
      text += theme.fg("dim", ` (${meta.join(" • ")})`);
    }

    return new Text(text, 0, 0);
  },
  renderResult(result, { expanded, isPartial }, theme, context) {
    const state = context.state as { interval?: ReturnType<typeof setInterval>; frame?: number };

    if (isPartial && !state.interval) {
      state.frame = state.frame ?? 0;
      state.interval = setInterval(() => {
        state.frame = ((state.frame ?? 0) + 1) % SPINNER_FRAMES.length;
        context.invalidate();
      }, 100);
    }

    if (!isPartial || context.isError) {
      if (state.interval) {
        clearInterval(state.interval);
        state.interval = undefined;
      }
    }

    if (isPartial) {
      const spinner = SPINNER_FRAMES[state.frame ?? 0] ?? SPINNER_FRAMES[0];
      let text = theme.fg("warning", `${spinner} searching the web`);
      if (context.args.query) {
        text += `\n${theme.fg("dim", context.args.query)}`;
      }
      return new Text(text, 0, 0);
    }

    const details = result.details as WebSearchDetails | undefined;
    const answer = (details?.answer ?? getTextContent(result.content)).trim();
    const sourceCount = details?.sources.length ?? 0;
    const queryCount = details?.searchQueries.length ?? 0;
    const summary: string[] = [];

    if (sourceCount > 0) {
      summary.push(`${sourceCount} source${sourceCount === 1 ? "" : "s"}`);
    }
    if (queryCount > 0) {
      summary.push(`${queryCount} search${queryCount === 1 ? "" : "es"}`);
    }
    if (details?.model) {
      summary.push(details.model);
    }

    if (context.isError) {
      const errorText = answer || "Web search failed.";
      const preview = truncateForDisplay(errorText, COLLAPSED_ERROR_MAX_LINES, COLLAPSED_ERROR_MAX_CHARS);
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const lines = [theme.fg("error", "↳ search failed")];
      if (preview.text) {
        lines.push(theme.fg("error", expanded ? errorText : preview.text));
      }
      text.setText(lines.join("\n"));
      return text;
    }

    const header = theme.fg("success", "↳ grounded result") + (summary.length > 0 ? ` ${theme.fg("dim", summary.join(" • "))}` : "");

    if (!expanded) {
      const preview = truncateForDisplay(answer || "No answer returned.", COLLAPSED_MAX_LINES, COLLAPSED_MAX_CHARS);
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const lines = [header];
      if (preview.text) {
        lines.push(theme.fg("toolOutput", preview.text));
      }
      if (preview.truncated) {
        lines.push(`${theme.fg("dim", "… full result available, ")}${keyHint("app.tools.expand", "to expand")}`);
      }
      text.setText(lines.join("\n"));
      return text;
    }

    const markdown = (details?.markdown ?? buildExpandedMarkdown(answer || "No answer returned.", details)).trim();
    const container = (context.lastComponent as Container | undefined) ?? new Container();
    container.clear();
    container.addChild(new Text(header, 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(markdown, 0, 0, getMarkdownTheme()));
    return container;
  },
  async execute(_toolCallId, params, signal) {
    const query = params.query.trim();
    if (!query) {
      throw new Error("websearch query is empty");
    }

    const model = normalizeModel(params.model);
    const timeoutMs = clampTimeout(params.timeoutMs);
    const state = await resolveLiteLLMState();
    const apiKey = (await resolveLiteLLMApiKey()) ?? process.env[LITELLM_API_KEY_ENV];

    if (!state.origin) {
      throw new Error(`LiteLLM gateway unavailable${state.error ? `: ${state.error}` : ""}`);
    }

    if (!apiKey) {
      throw new Error(`LiteLLM API key not configured. Authenticate provider "litellm" or set ${LITELLM_API_KEY_ENV}.`);
    }

    const endpoint = `${state.origin}/v1beta/models/${model}:generateContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
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
      }),
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
      details: {
        query,
        model,
        endpoint,
        answer: result.answer,
        markdown: formatMarkdownResult(result),
        searchQueries: result.searchQueries,
        sources: result.sources,
      } satisfies WebSearchDetails,
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
    "5. Format: return JSON that strictly matches the schema.",
    "</instructions>",
    "",
    "<constraints>",
    "- Verbosity: High",
    "- Tone: Technical",
    "- No fabricated facts or URLs",
    "- Do not reveal planning, analysis, or tool-use reasoning",
    "- Output ONLY valid JSON matching the schema",
    "</constraints>",
    "",
    "<output_format>",
    "{",
    '  "answer": "..."',
    '  "sources": [{ "title": "...", "url": "..." }],',
    '  "searchQueries": ["..."]',
    "}",
    "</output_format>",
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
    "Use deeper reasoning internally, but output only the required JSON format.",
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
