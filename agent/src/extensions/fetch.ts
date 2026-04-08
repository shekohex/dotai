import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Firecrawl, { type Document, type ScrapeOptions } from "@mendable/firecrawl-js";
import {
  AuthStorage,
  type AgentToolUpdateCallback,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  keyHint,
  truncateHead,
  type ExtensionAPI,
  type TruncationResult,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

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
  "  - Format options: \"markdown\" (default), \"text\", or \"html\"",
  "  - This tool is read-only and does not modify any files",
  "  - Results may be summarized if the content is very large",
].join("\n");

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const STREAM_PREVIEW_LINE_LIMIT = 8;
const STREAM_PREVIEW_LINE_LENGTH = 220;
const COLLAPSED_ERROR_MAX_LINES = 8;
const COLLAPSED_ERROR_MAX_CHARS = 1200;
const STATUS_CONTENT_TYPE_MAX_LENGTH = 44;
const TOOL_TEXT_PADDING_X = 0;
const TOOL_TEXT_PADDING_Y = 0;
const DEFAULT_FIRECRAWL_API_URL = "http://192.168.1.121:3000/";
const FIRECRAWL_AUTH_PROVIDER = "firecrawl";
export const FIRECRAWL_API_KEY_ENV = "FIRECRAWL_API_KEY";
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
  fg: (color: "accent" | "dim" | "error" | "muted" | "success" | "toolOutput" | "warning", text: string) => string;
};

const webFetchSchema = Type.Object({
  url: Type.String({ description: "The URL to fetch content from" }),
  format: Type.Optional(
    Type.Union(
      [Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")],
      {
        default: "markdown",
        description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      },
    ),
  ),
  timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds (max 120)" })),
});

export const webFetchTool = defineTool({
  name: "webfetch",
  label: "fetch",
  description: WEBFETCH_DESCRIPTION,
  promptSnippet: "use `webfetch` tool when you need to get the conent of a url or a website. could be useful to explore more information from the references output of the `websearch` tool.",
  parameters: webFetchSchema,
  renderCall(args, theme, context) {
    const state = syncRenderState(context, context.isPartial);
    const url = shortenUrl(typeof args.url === "string" ? upgradeToHttps(args.url.trim()) : "...");
    const timeoutSeconds = clampTimeout(typeof args.timeout === "number" ? args.timeout : undefined);
    const elapsedMs = getElapsedMs(state);
    const phase = context.isError ? "error" : context.isPartial ? "partial" : "success";

    switch (phase) {
      case "error": {
        const suffix = elapsedMs !== undefined ? theme.fg("muted", ` after ${formatDurationHuman(elapsedMs)}`) : "";
        return createTextComponent(
          context.lastComponent,
          `${theme.fg("error", "✗ fetch")} ${theme.fg("accent", url)}${suffix}`,
        );
      }
      case "partial":
        return createTextComponent(
          context.lastComponent,
          `${theme.fg("dim", "… fetching")} ${theme.fg("accent", url)}${theme.fg("muted", ` (${timeoutSeconds}s)`)}`,
        );
      case "success": {
        const suffix = elapsedMs !== undefined ? theme.fg("muted", ` in ${formatDurationHuman(elapsedMs)}`) : "";
        return createTextComponent(
          context.lastComponent,
          `${theme.fg("muted", "✓ fetched")} ${theme.fg("accent", url)}${suffix}`,
        );
      }
    }
  },
  renderResult(result, options, theme, context) {
    const details = result.details as WebFetchDetails | undefined;
    const textContent = getTextContent(result.content);
    const phase = context.isError ? "error" : options.isPartial ? "partial" : "complete";

    switch (phase) {
      case "error": {
        const preview = truncateForDisplay(textContent || "webfetch failed", COLLAPSED_ERROR_MAX_LINES, COLLAPSED_ERROR_MAX_CHARS);
        const message = options.expanded ? (textContent || "webfetch failed") : (preview.text || textContent || "webfetch failed");
        return createTextComponent(context.lastComponent, renderToolErrorLine(message, theme));
      }
      case "partial": {
        const streamed = styleToolOutput(textContent, theme, STREAM_PREVIEW_LINE_LENGTH);
        const elapsed = details?.durationMs !== undefined ? ` (${formatDurationHuman(details.durationMs)})` : "";
        return renderStreamingPreview(streamed, theme, context.lastComponent, {
          expanded: options.expanded,
          footer: `${summarizeLineCount(countTextLines(textContent))} so far${elapsed}${details ? ` · ${renderStatusMeta(details, theme)}` : ""}`,
          expandHint: !options.expanded && textContent.trim().length > 0,
        });
      }
      case "complete": {
        if (!details) {
          return createTextComponent(context.lastComponent, "");
        }

        const summary = `${renderStatusMeta(details, theme)}${theme.fg("muted", " · ")}${keyHint("app.tools.expand", "to expand")}`;
        if (!options.expanded) {
          return createTextComponent(context.lastComponent, `${theme.fg("dim", "↳ ")}${summary}`);
        }

        const body = details.body.trim();
        if (!body) {
          return createTextComponent(context.lastComponent, `${theme.fg("dim", "↳ ")}${renderStatusMeta(details, theme)}`);
        }

        return createTextComponent(
          context.lastComponent,
          `${theme.fg("dim", "↳ ")}${renderStatusMeta(details, theme)}\n${styleToolOutput(body, theme, STREAM_PREVIEW_LINE_LENGTH)}`,
        );
      }
    }
  },
  async execute(_toolCallId, params, signal, onUpdate) {
    const originalUrl = params.url.trim();
    if (!originalUrl) {
      throw new Error("webfetch url is empty");
    }
    if (!/^https?:\/\//i.test(originalUrl)) {
      throw new Error("The URL must be a fully-formed valid URL");
    }

    const url = upgradeToHttps(originalUrl);
    const format = normalizeFormat(params.format);
    const timeoutSeconds = clampTimeout(params.timeout);
    const timeoutMs = timeoutSeconds * 1000;
    const startedAt = Date.now();
    const abortState = createAbortPromise<Document>(signal, timeoutMs);

    onUpdate?.({
      content: [],
      details: {
        url,
        finalUrl: url,
        format,
        status: 0,
        statusText: "",
        contentType: "",
        bytes: 0,
        durationMs: 0,
        timeoutSeconds,
        body: "",
        isBinary: false,
      } satisfies Partial<WebFetchDetails>,
    });

    try {
      const client = await createFirecrawlClient(timeoutMs);
      const document = await Promise.race([
        client.scrape(url, buildScrapeOptions(format)),
        abortState.promise,
      ]);

      const details = await buildDetails({
        url,
        format,
        durationMs: Date.now() - startedAt,
        timeoutSeconds,
        document,
      });

      emitPartialUpdate(onUpdate, details);

      return {
        content: [{ type: "text", text: formatResult(details) }],
        details,
      };
    } catch (error) {
      if (abortState.didTimeout() || isTimeoutError(error)) {
        throw new Error(`Request timed out after ${timeoutSeconds}s`);
      }
      if (signal?.aborted) {
        throw new Error("Request aborted");
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      abortState.cleanup();
    }
  },
});

export default function webFetchExtension(pi: ExtensionAPI) {
  pi.registerTool(webFetchTool);
}

function normalizeFormat(format: WebFetchFormat | undefined): WebFetchFormat {
  switch (format) {
    case "text":
    case "markdown":
    case "html":
      return format;
    default:
      return "markdown";
  }
}

function clampTimeout(timeout: number | undefined): number {
  if (!Number.isFinite(timeout)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }

  return Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.trunc(timeout as number)));
}

function getFirecrawlApiUrl(): string {
  return (process.env.WEBFETCH_FIRECRAWL_API_URL ?? process.env.FIRECRAWL_API_URL ?? DEFAULT_FIRECRAWL_API_URL).replace(/\/$/, "");
}

async function createFirecrawlClient(timeoutMs: number): Promise<Firecrawl> {
  return new Firecrawl({
    apiKey: await resolveFirecrawlApiKey(),
    apiUrl: getFirecrawlApiUrl(),
    timeoutMs,
    maxRetries: 1,
  });
}

export async function resolveFirecrawlApiKey(): Promise<string> {
  return (await AuthStorage.create().getApiKey(FIRECRAWL_AUTH_PROVIDER, { includeFallback: false }))
    ?? process.env[FIRECRAWL_API_KEY_ENV]
    ?? DEFAULT_FIRECRAWL_API_KEY;
}

function buildScrapeOptions(format: WebFetchFormat): ScrapeOptions {
  return {
    formats: format === "html"
      ? ["html"]
      : format === "text"
        ? ["summary", "markdown"]
        : ["markdown"],
    onlyMainContent: true,
    removeBase64Images: true,
    blockAds: true,
  };
}

function createAbortPromise<T>(signal: AbortSignal | undefined, timeoutMs: number): {
  promise: Promise<T>;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  let timedOut = false;
  let timeoutId: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;

  const promise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(`timeout:${timeoutMs}`));
    }, timeoutMs);

    if (!signal) {
      return;
    }

    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }

    abortHandler = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", abortHandler, { once: true });
  });

  return {
    promise,
    cleanup() {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    },
    didTimeout() {
      return timedOut;
    },
  };
}

async function buildDetails(input: {
  url: string;
  format: WebFetchFormat;
  durationMs: number;
  timeoutSeconds: number;
  document: Document;
}): Promise<WebFetchDetails> {
  const rawBody = resolveRawBody(input.document, input.format);
  const body = resolveBody(input.document, input.format);
  const bytes = Buffer.byteLength(rawBody || body, "utf8");

  if (bytes > MAX_RESPONSE_BYTES) {
    throw new Error(`Response too large (${formatSize(bytes)} > ${formatSize(MAX_RESPONSE_BYTES)})`);
  }

  const truncation = truncateHead(body, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let truncatedBody = truncation.content;
  let fullOutputPath: string | undefined;

  if (truncation.truncated) {
    fullOutputPath = getTempFilePath();
    await withFileMutationQueue(fullOutputPath, async () => {
      await writeFile(fullOutputPath!, body, "utf8");
    });

    if (truncation.firstLineExceedsLimit) {
      truncatedBody = `[Response body line 1 exceeds ${formatSize(truncation.maxBytes)}. Full output saved to: ${fullOutputPath}]`;
    } else if (truncation.truncatedBy === "lines") {
      truncatedBody += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines. Full output saved to: ${fullOutputPath}]`;
    } else {
      truncatedBody += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
    }
  }

  const finalUrl = resolveFinalUrl(input.document, input.url);
  const status = resolveStatus(input.document, body || rawBody);

  return {
    url: input.url,
    finalUrl,
    format: input.format,
    status,
    statusText: normalizeStatusText("", status),
    contentType: resolveContentType(input.document, input.format),
    bytes,
    durationMs: input.durationMs,
    timeoutSeconds: input.timeoutSeconds,
    body: truncatedBody,
    rawBody,
    isBinary: false,
    truncation: truncation.truncated ? truncation : undefined,
    fullOutputPath,
  };
}

function emitPartialUpdate(onUpdate: AgentToolUpdateCallback<unknown> | undefined, details: WebFetchDetails): void {
  if (!onUpdate) {
    return;
  }

  onUpdate({
    content: details.body ? [{ type: "text", text: details.body }] : [],
    details,
  });
}

function resolveRawBody(document: Document, format: WebFetchFormat): string {
  switch (format) {
    case "html":
      return pickFirstString(document.html, document.rawHtml);
    case "markdown":
      return pickFirstString(document.markdown, document.summary, document.answer, document.html, document.rawHtml);
    case "text":
      return pickFirstString(document.summary, document.markdown, document.answer, document.html, document.rawHtml);
  }
}

function resolveBody(document: Document, format: WebFetchFormat): string {
  switch (format) {
    case "html":
      return pickFirstString(document.html, document.rawHtml);
    case "markdown":
      return pickFirstString(document.markdown, document.summary, document.answer, document.html, document.rawHtml);
    case "text":
      return pickFirstString(document.summary, document.markdown, document.answer, document.html, document.rawHtml);
  }
}

function resolveFinalUrl(document: Document, fallbackUrl: string): string {
  return pickFirstString(document.metadata?.url, document.metadata?.sourceURL, fallbackUrl) || fallbackUrl;
}

function resolveStatus(document: Document, body: string): number {
  const status = document.metadata?.statusCode;
  if (typeof status === "number" && Number.isFinite(status) && status > 0) {
    return status;
  }

  return body ? 200 : 204;
}

function resolveContentType(document: Document, format: WebFetchFormat): string {
  const contentType = document.metadata?.contentType;
  if (typeof contentType === "string" && contentType.trim().length > 0) {
    return contentType.trim();
  }

  switch (format) {
    case "html":
      return "text/html; charset=utf-8";
    case "markdown":
      return "text/markdown; charset=utf-8";
    case "text":
      return "text/plain; charset=utf-8";
  }
}

function pickFirstString(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.replace(/\r\n/g, "\n").trim();
    }
  }

  return "";
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as Error & { code?: string }).code;
  const message = error.message.toLowerCase();
  return code === "ETIMEDOUT" || message.includes("timed out") || message.includes("timeout");
}

function formatResult(details: WebFetchDetails): string {
  const lines = [
    `URL: ${details.finalUrl}`,
    `Status: ${details.status} ${details.statusText}`,
    `Content-Type: ${details.contentType}`,
    `Bytes: ${formatSize(details.bytes)}`,
  ];

  if (details.finalUrl !== details.url) {
    lines.push(`Original URL: ${details.url}`);
  }

  if (details.body) {
    lines.push("", details.body);
  }

  return lines.join("\n");
}

function renderStatusMeta(
  details: Pick<WebFetchDetails, "status" | "statusText" | "contentType" | "bytes" | "truncation">,
  theme: ToolTheme,
): string {
  const color = details.status >= 200 && details.status < 300
    ? "success"
    : details.status >= 300 && details.status < 400
      ? "warning"
      : details.status >= 400
        ? "error"
        : "muted";
  const parts = [theme.fg(color, `${details.status} ${details.statusText}`.trim())];

  if (details.contentType) {
    parts.push(theme.fg("muted", truncateMiddle(details.contentType, STATUS_CONTENT_TYPE_MAX_LENGTH)));
  }

  parts.push(theme.fg("muted", formatSize(details.bytes)));

  if (details.truncation?.truncated) {
    parts.push(theme.fg("warning", "truncated"));
  }

  return parts.join(`${theme.fg("muted", " · ")}`);
}

function renderStreamingPreview(
  renderedText: string,
  theme: ToolTheme,
  lastComponent: unknown,
  options: { expanded: boolean; footer?: string; expandHint?: boolean },
): Text {
  const lines = renderedText.split("\n").filter((line) => line.length > 0);

  if (options.expanded) {
    const footer = options.footer ? `${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}` : "";
    return createTextComponent(lastComponent, [renderedText, footer].filter(Boolean).join("\n"));
  }

  const visibleLines = lines.slice(-STREAM_PREVIEW_LINE_LIMIT);
  const earlierCount = Math.max(lines.length - visibleLines.length, 0);
  const blocks: string[] = [];

  if (earlierCount > 0) {
    blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", `... (${earlierCount} earlier lines)`)}`);
  }

  if (visibleLines.length > 0) {
    blocks.push(visibleLines.join("\n"));
  }

  if (options.footer) {
    blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}`);
  }

  if (options.expandHint) {
    blocks.push(`${theme.fg("dim", "↳ ")}${keyHint("app.tools.expand", "to expand")}`);
  }

  return createTextComponent(lastComponent, blocks.join("\n"));
}

function renderToolErrorLine(message: string, theme: ToolTheme): string {
  return `${theme.fg("error", "↳ ")}${theme.fg("error", message.trim())}`;
}

function syncRenderState(
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
): WebFetchRenderState {
  const state = context.state as WebFetchRenderState;

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

function getElapsedMs(state: WebFetchRenderState): number | undefined {
  if (state.startedAt === undefined) {
    return undefined;
  }

  return (state.endedAt ?? Date.now()) - state.startedAt;
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

function countTextLines(content: string): number {
  if (!content) {
    return 0;
  }
  return content.split("\n").length;
}

function summarizeLineCount(lineCount: number): string {
  return `${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

function styleToolOutput(
  text: string,
  theme: ToolTheme,
  maxLineLength?: number,
): string {
  if (!text) {
    return "";
  }

  return text
    .split("\n")
    .map((line) => {
      if (maxLineLength === undefined || line.length <= maxLineLength) {
        return theme.fg("toolOutput", line);
      }
      const visibleText = line.slice(0, maxLineLength);
      const truncatedChars = line.length - maxLineLength;
      return `${theme.fg("toolOutput", visibleText)}${theme.fg("muted", ` …(truncated ${truncatedChars} chars)…`)}`;
    })
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

function getTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function createTextComponent(lastComponent: unknown, text: string): Text {
  const component = lastComponent instanceof Text ? lastComponent : new Text("", TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y);
  component.setText(text);
  return component;
}

function normalizeStatusText(statusText: string, status: number): string {
  const trimmed = statusText.trim();
  if (trimmed) {
    return trimmed;
  }

  switch (status) {
    case 200:
      return "OK";
    case 201:
      return "Created";
    case 202:
      return "Accepted";
    case 204:
      return "No Content";
    case 301:
      return "Moved Permanently";
    case 302:
      return "Found";
    case 303:
      return "See Other";
    case 307:
      return "Temporary Redirect";
    case 308:
      return "Permanent Redirect";
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 429:
      return "Too Many Requests";
    case 500:
      return "Internal Server Error";
    case 502:
      return "Bad Gateway";
    case 503:
      return "Service Unavailable";
    case 504:
      return "Gateway Timeout";
    default:
      return "";
  }
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

function getTempFilePath(): string {
  return join(tmpdir(), `pi-webfetch-${randomUUID()}.txt`);
}
