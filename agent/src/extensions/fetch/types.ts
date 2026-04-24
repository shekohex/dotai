import os from "node:os";
import path from "node:path";
import type { TruncationResult } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const WEBFETCH_DESCRIPTION = [
  "- Fetches content from a specified URL",
  "- Takes a URL and optional format as input",
  "- Fetches the URL content, converts to requested format (markdown by default)",
  "- Returns the content in the specified format",
  "- Use this tool when you need to retrieve and analyze web content",
  "",
  "Usage notes:",
  "  - IMPORTANT: if another tool is present that offers better web fetching capabilities, is more targeted to the task, or has fewer restrictions, prefer using that tool instead of this one.",
  "  - The URL must be a fully-formed valid URL",
  "  - HTTP URLs will be automatically upgraded to HTTPS",
  '  - Format options: "markdown" (default), "text", or "html"',
  "  - This tool is read-only and does not modify any files",
  "  - Results may be summarized if the content is very large",
].join("\n");

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const STREAM_PREVIEW_LINE_LIMIT = 8;
const STREAM_PREVIEW_LINE_LENGTH = 220;
const STATUS_CONTENT_TYPE_MAX_LENGTH = 44;
const TOOL_TEXT_PADDING_X = 0;
const TOOL_TEXT_PADDING_Y = 0;
const DEFAULT_FIRECRAWL_API_URL = "http://192.168.1.121:3000/";
const FIRECRAWL_AUTH_PROVIDER = "firecrawl";
const FIRECRAWL_API_KEY_ENV = "FIRECRAWL_API_KEY";
const DEFAULT_FIRECRAWL_API_KEY = "fc-free";

type WebFetchFormat = "markdown" | "text" | "html";

type WebFetchDetails = {
  url: string;
  finalUrl: string;
  format: WebFetchFormat;
  status: number;
  statusText: string;
  contentType: string;
  bytes: number;
  durationMs: number;
  timeoutSeconds: number;
  body: string;
  rawBody?: string;
  isBinary: boolean;
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

type WebFetchRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
};

type ToolTheme = {
  fg: (
    color:
      | "accent"
      | "borderAccent"
      | "borderMuted"
      | "dim"
      | "error"
      | "muted"
      | "success"
      | "toolOutput"
      | "warning",
    text: string,
  ) => string;
  italic: (text: string) => string;
  bold: (text: string) => string;
};

const webFetchSchema = Type.Object({
  url: Type.String({ description: "The URL to fetch content from" }),
  format: Type.Optional(
    Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
      default: "markdown",
      description:
        "The format to return the content in (text, markdown, or html). Defaults to markdown.",
    }),
  ),
  timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds (max 120)" })),
});

const WebFetchDetailsSchema = Type.Object(
  {
    url: Type.String(),
    finalUrl: Type.String(),
    format: Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")]),
    status: Type.Number(),
    statusText: Type.String(),
    contentType: Type.String(),
    bytes: Type.Number(),
    durationMs: Type.Number(),
    timeoutSeconds: Type.Number(),
    body: Type.String(),
    rawBody: Type.Optional(Type.String()),
    isBinary: Type.Boolean(),
    truncation: Type.Optional(Type.Any()),
    fullOutputPath: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const WebFetchRenderStateSchema = Type.Object(
  {
    startedAt: Type.Optional(Type.Number()),
    endedAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

function parseWebFetchDetails(value: unknown): WebFetchDetails | undefined {
  if (!Value.Check(WebFetchDetailsSchema, value)) {
    return undefined;
  }
  return Value.Parse(WebFetchDetailsSchema, value);
}

function isWebFetchRenderState(value: unknown): value is WebFetchRenderState {
  return Value.Check(WebFetchRenderStateSchema, value);
}

function normalizeFormat(format: WebFetchFormat | undefined): WebFetchFormat {
  switch (format) {
    case undefined:
      return "markdown";
    case "text":
    case "markdown":
    case "html":
      return format;
  }
  return "markdown";
}

function clampTimeout(timeout: number | undefined): number {
  if (typeof timeout !== "number" || !Number.isFinite(timeout)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.trunc(timeout)));
}

function getFirecrawlApiUrl(): string {
  return (
    process.env.WEBFETCH_FIRECRAWL_API_URL ??
    process.env.FIRECRAWL_API_URL ??
    DEFAULT_FIRECRAWL_API_URL
  ).replace(/\/$/, "");
}

function normalizeStatusText(statusText: string, status: number): string {
  const trimmed = statusText.trim();
  if (trimmed) {
    return trimmed;
  }

  const labels: Record<number, string> = {
    200: "OK",
    201: "Created",
    202: "Accepted",
    204: "No Content",
    301: "Moved Permanently",
    302: "Found",
    303: "See Other",
    307: "Temporary Redirect",
    308: "Permanent Redirect",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return labels[status] ?? "";
}

function upgradeToHttps(url: string): string {
  if (url.startsWith("http://")) {
    return `https://${url.slice("http://".length)}`;
  }
  return url;
}

function shortenUrl(url: string, maxLength = 96): string {
  if (url.length <= maxLength) {
    return url;
  }
  try {
    const parsed = new URL(url);
    const base = `${parsed.origin}${parsed.pathname}`;
    if (base.length <= maxLength) {
      return truncateMiddle(`${base}${parsed.search}${parsed.hash}`, maxLength);
    }
    return truncateMiddle(base, maxLength);
  } catch {
    return truncateMiddle(url, maxLength);
  }
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const headLength = Math.max(1, Math.floor((maxLength - 1) / 2));
  const tailLength = Math.max(1, maxLength - headLength - 1);
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}

function getTempFilePath(randomId: string): string {
  return path.join(os.tmpdir(), `pi-webfetch-${randomId}.txt`);
}

export {
  clampTimeout,
  DEFAULT_FIRECRAWL_API_KEY,
  FIRECRAWL_API_KEY_ENV,
  FIRECRAWL_AUTH_PROVIDER,
  getFirecrawlApiUrl,
  getTempFilePath,
  isWebFetchRenderState,
  MAX_RESPONSE_BYTES,
  normalizeFormat,
  normalizeStatusText,
  parseWebFetchDetails,
  shortenUrl,
  STATUS_CONTENT_TYPE_MAX_LENGTH,
  STREAM_PREVIEW_LINE_LENGTH,
  STREAM_PREVIEW_LINE_LIMIT,
  TOOL_TEXT_PADDING_X,
  TOOL_TEXT_PADDING_Y,
  upgradeToHttps,
  WEBFETCH_DESCRIPTION,
  webFetchSchema,
};
export type { ToolTheme, WebFetchDetails, WebFetchFormat, WebFetchRenderState };
export type { Static };
