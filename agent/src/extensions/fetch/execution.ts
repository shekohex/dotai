import FirecrawlApi, { type Document, type ScrapeOptions } from "@mendable/firecrawl-js";
import { AuthStorage, type AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import { buildDetails, isTimeoutError } from "./execution-details.js";
import { formatResult } from "./render.js";
import {
  clampTimeout,
  DEFAULT_FIRECRAWL_API_KEY,
  FIRECRAWL_API_KEY_ENV,
  FIRECRAWL_AUTH_PROVIDER,
  getFirecrawlApiUrl,
  normalizeFormat,
  upgradeToHttps,
  type WebFetchDetails,
  type WebFetchFormat,
} from "./types.js";

type WebFetchRequest = {
  url: string;
  format: WebFetchFormat;
  timeoutSeconds: number;
  timeoutMs: number;
  startedAt: number;
  abortState: ReturnType<typeof createAbortPromise<Document>>;
  signal: AbortSignal | undefined;
};

function createWebFetchRequest(
  params: { url: string; format?: WebFetchFormat; timeout?: number },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): WebFetchRequest {
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

  return { url, format, timeoutSeconds, timeoutMs, startedAt, abortState, signal };
}

async function executeWebFetchRequest(
  request: WebFetchRequest,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: WebFetchDetails }> {
  try {
    const client = await createFirecrawlClient(request.timeoutMs);
    const document = await Promise.race([
      client.scrape(request.url, buildScrapeOptions(request.format)),
      request.abortState.promise,
    ]);
    const details = await buildDetails({
      url: request.url,
      format: request.format,
      durationMs: Date.now() - request.startedAt,
      timeoutSeconds: request.timeoutSeconds,
      document,
    });
    emitPartialUpdate(onUpdate, details);
    return { content: [{ type: "text", text: formatResult(details) }], details };
  } catch (error) {
    if (request.abortState.didTimeout() || isTimeoutError(error)) {
      throw new Error(`Request timed out after ${request.timeoutSeconds}s`, { cause: error });
    }
    if (request.signal?.aborted === true) {
      throw new Error("Request aborted", { cause: error });
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    request.abortState.cleanup();
  }
}

async function createFirecrawlClient(timeoutMs: number): Promise<FirecrawlApi> {
  return new FirecrawlApi({
    apiKey: await resolveFirecrawlApiKey(),
    apiUrl: getFirecrawlApiUrl(),
    timeoutMs,
    maxRetries: 1,
  });
}

async function resolveFirecrawlApiKey(): Promise<string> {
  return (
    (await AuthStorage.create().getApiKey(FIRECRAWL_AUTH_PROVIDER, { includeFallback: false })) ??
    process.env[FIRECRAWL_API_KEY_ENV] ??
    DEFAULT_FIRECRAWL_API_KEY
  );
}

function buildScrapeOptions(format: WebFetchFormat): ScrapeOptions {
  let formats: ScrapeOptions["formats"];
  switch (format) {
    case "html":
      formats = ["html"];
      break;
    case "text":
      formats = ["summary", "markdown"];
      break;
    case "markdown":
      formats = ["markdown"];
      break;
  }

  return {
    formats,
    onlyMainContent: true,
    removeBase64Images: true,
    blockAds: true,
  };
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string") {
    return new Error(reason);
  }
  return new Error("aborted");
}

type AbortPromiseState<T> = {
  promise: Promise<T>;
  cleanup: () => void;
  didTimeout: () => boolean;
};

function createAbortPromise<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortPromiseState<T> {
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
      reject(toAbortError(signal.reason));
      return;
    }

    abortHandler = () => {
      reject(toAbortError(signal.reason));
    };
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
function emitPartialUpdate(
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  details: WebFetchDetails,
): void {
  if (!onUpdate) {
    return;
  }
  onUpdate({
    content: details.body ? [{ type: "text", text: details.body }] : [],
    details,
  });
}

export { createWebFetchRequest, executeWebFetchRequest, resolveFirecrawlApiKey };
