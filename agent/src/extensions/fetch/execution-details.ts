import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { type Document } from "@mendable/firecrawl-js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import {
  getTempFilePath,
  MAX_RESPONSE_BYTES,
  normalizeStatusText,
  type WebFetchDetails,
  type WebFetchFormat,
} from "./types.js";

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
    throw new Error(
      `Response too large (${formatSize(bytes)} > ${formatSize(MAX_RESPONSE_BYTES)})`,
    );
  }
  const truncationState = await truncateFetchBody(body);
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
    body: truncationState.body,
    rawBody,
    isBinary: false,
    truncation: truncationState.truncation,
    fullOutputPath: truncationState.fullOutputPath,
  };
}

async function truncateFetchBody(body: string): Promise<{
  body: string;
  truncation: TruncationResult | undefined;
  fullOutputPath: string | undefined;
}> {
  const truncation = truncateHead(body, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) {
    return { body: truncation.content, truncation: undefined, fullOutputPath: undefined };
  }

  const fullOutputPath = getTempFilePath(randomUUID());
  await withFileMutationQueue(fullOutputPath, async () => {
    await writeFile(fullOutputPath, body, "utf8");
  });

  return {
    body: buildTruncatedFetchBodyText(truncation, fullOutputPath),
    truncation,
    fullOutputPath,
  };
}

function buildTruncatedFetchBodyText(truncation: TruncationResult, fullOutputPath: string): string {
  if (truncation.firstLineExceedsLimit) {
    return `[Response body line 1 exceeds ${formatSize(truncation.maxBytes)}. Full output saved to: ${fullOutputPath}]`;
  }
  if (truncation.truncatedBy === "lines") {
    return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines. Full output saved to: ${fullOutputPath}]`;
  }

  return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
}

function resolveRawBody(document: Document, format: WebFetchFormat): string {
  switch (format) {
    case "html":
      return pickFirstString(document.html, document.rawHtml);
    case "markdown":
      return pickFirstString(
        document.markdown,
        document.summary,
        document.answer,
        document.html,
        document.rawHtml,
      );
    case "text":
      return pickFirstString(
        document.summary,
        document.markdown,
        document.answer,
        document.html,
        document.rawHtml,
      );
  }

  return "";
}

function resolveBody(document: Document, format: WebFetchFormat): string {
  return resolveRawBody(document, format);
}

function resolveFinalUrl(document: Document, fallbackUrl: string): string {
  return (
    pickFirstString(document.metadata?.url, document.metadata?.sourceURL, fallbackUrl) ||
    fallbackUrl
  );
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

  return "text/plain; charset=utf-8";
}

function pickFirstString(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.replaceAll("\r\n", "\n").trim();
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

export { buildDetails, isTimeoutError };
