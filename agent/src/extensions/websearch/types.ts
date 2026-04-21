import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const WEBSEARCH_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"] as const;
const WEBSEARCH_PROVIDER = "gemini";
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

type ToolTheme = {
  fg: (color: "dim" | "muted" | "error" | "toolOutput" | "accent", text: string) => string;
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

type SearchResultLike = Pick<SearchResult, "sources" | "searchQueries">;

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

const WebSearchSourceSchema = Type.Object({
  title: Type.String(),
  url: Type.String(),
});

const StructuredSearchResultSchema = Type.Object(
  {
    answer: Type.Optional(Type.String()),
    sources: Type.Optional(
      Type.Array(
        Type.Object({
          title: Type.Optional(Type.String()),
          url: Type.Optional(Type.String()),
        }),
      ),
    ),
    searchQueries: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);

const WebSearchDetailsSchema = Type.Object(
  {
    query: Type.String(),
    model: Type.String(),
    timeoutMs: Type.Number(),
    durationMs: Type.Number(),
    endpoint: Type.String(),
    answer: Type.String(),
    markdown: Type.String(),
    searchQueries: Type.Array(Type.String()),
    sources: Type.Array(WebSearchSourceSchema),
  },
  { additionalProperties: true },
);

const WebSearchRenderStateSchema = Type.Object(
  {
    startedAt: Type.Optional(Type.Number()),
    endedAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Value.Check(UnknownRecordSchema, value)) {
    return undefined;
  }
  return Value.Parse(UnknownRecordSchema, value);
}

function parseWebSearchDetails(details: unknown): WebSearchDetails | undefined {
  if (!Value.Check(WebSearchDetailsSchema, details)) {
    return undefined;
  }
  return Value.Parse(WebSearchDetailsSchema, details);
}

function isWebSearchRenderState(value: unknown): value is WebSearchRenderState {
  return Value.Check(WebSearchRenderStateSchema, value);
}

export {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_SEARCH_QUERIES,
  MAX_SOURCES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  STREAM_PREVIEW_LINE_LIMIT,
  THINKING_BUDGET,
  TOOL_TEXT_PADDING_X,
  TOOL_TEXT_PADDING_Y,
  WEBSEARCH_MODELS,
  WEBSEARCH_PROVIDER,
  WebSearchSourceSchema,
  StructuredSearchResultSchema,
  asRecord,
  isWebSearchRenderState,
  parseWebSearchDetails,
};
export type {
  SearchResult,
  SearchResultLike,
  ToolTheme,
  WebSearchDetails,
  WebSearchRenderState,
  WebSearchSource,
};
export type StructuredSearchResult = Static<typeof StructuredSearchResultSchema>;
