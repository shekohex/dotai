export { compress } from "hono/compress";
export { cors } from "hono/cors";
export { requestId } from "hono/request-id";
export { secureHeaders } from "hono/secure-headers";
export { openAPIRouteHandler } from "hono-openapi";
import type { MiddlewareHandler } from "hono";

export interface RemoteLoggerOptions {
  enabled: boolean;
  pretty: boolean;
  color: boolean;
  logSse: boolean;
  maxBodyChars: number;
}

const ANSI = {
  reset: "\u001B[0m",
  cyan: "\u001B[36m",
  magenta: "\u001B[35m",
  red: "\u001B[31m",
  gray: "\u001B[90m",
} as const;

const DEFAULT_LOGGER_OPTIONS: RemoteLoggerOptions = {
  enabled: true,
  pretty: true,
  color: process.stdout.isTTY,
  logSse: true,
  maxBodyChars: 8_000,
};

let activeLoggerOptions: RemoteLoggerOptions = { ...DEFAULT_LOGGER_OPTIONS };

const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|set-cookie|api[-_]?key|token|secret|password|private[-_]?key|signature/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactByKey(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }
  return redactSensitiveData(value);
}

function redactSensitiveData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactByKey(key, item)]),
    );
  }
  return value;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]`;
}

function toLoggerOptions(options: Partial<RemoteLoggerOptions> | undefined): RemoteLoggerOptions {
  activeLoggerOptions = {
    ...DEFAULT_LOGGER_OPTIONS,
    ...activeLoggerOptions,
    ...options,
  };
  return activeLoggerOptions;
}

function formatLogPayload(payload: unknown, options: RemoteLoggerOptions): string {
  const redacted = redactSensitiveData(payload);
  if (!options.pretty) {
    return JSON.stringify(redacted);
  }
  return JSON.stringify(redacted, null, 2);
}

function emitLog(kind: "http" | "http_error" | "sse", payload: unknown): void {
  const options = activeLoggerOptions;
  if (!options.enabled) {
    return;
  }

  const body = formatLogPayload(payload, options);
  if (!options.color) {
    console.log(body);
    return;
  }

  let kindColor: string = ANSI.red;
  if (kind === "http") {
    kindColor = ANSI.cyan;
  } else if (kind === "sse") {
    kindColor = ANSI.magenta;
  }
  const header = `${ANSI.gray}${new Date().toISOString()}${ANSI.reset} ${kindColor}[${kind}]${ANSI.reset}`;
  console.log(`${header}\n${body}`);
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const entries = [...headers.entries()].toSorted(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

function formatUnknownError(error: unknown): { message: string } {
  if (typeof error === "string") {
    return { message: error };
  }
  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint" ||
    typeof error === "symbol"
  ) {
    return { message: String(error) };
  }
  if (error === null || error === undefined) {
    return { message: "Unknown error" };
  }

  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: "Unserializable error" };
  }
}

function asJson(text: string, limit: number): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return truncateText(text, limit);
  }
}

async function readRequestBody(request: Request, limit: number): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("multipart/form-data")) {
    return "[multipart/form-data]";
  }

  const text = await request.clone().text();
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    return asJson(text, limit);
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  return text.length > 0 ? truncateText(text, limit) : undefined;
}

async function readResponseBody(response: Response, limit: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const contentEncoding = response.headers.get("content-encoding")?.toLowerCase() ?? "";
  if (response.body === null) {
    return undefined;
  }

  if (contentEncoding.length > 0 && contentEncoding !== "identity") {
    return `[encoded:${contentEncoding}]`;
  }

  if (contentType.includes("text/event-stream")) {
    return "[event-stream; see sse logs]";
  }

  const text = await response.clone().text();
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    return asJson(text, limit);
  }
  return text.length > 0 ? truncateText(text, limit) : undefined;
}

export function logger(options?: Partial<RemoteLoggerOptions>): MiddlewareHandler {
  const config = toLoggerOptions(options);
  if (!config.enabled) {
    return async (_c, next) => {
      await next();
    };
  }

  return async (c, next) => {
    const startedAt = Date.now();
    let caughtError: unknown;
    let didCatchError = false;

    try {
      await next();
    } catch (error) {
      caughtError = error;
      didCatchError = true;
      throw error;
    } finally {
      const endedAt = Date.now();
      const requestBody = await readRequestBody(c.req.raw, config.maxBodyChars).catch(
        () => "[unreadable]",
      );
      const responseBody = await readResponseBody(c.res, config.maxBodyChars).catch(
        () => "[unreadable]",
      );
      const payload = {
        ts: new Date(startedAt).toISOString(),
        durationMs: endedAt - startedAt,
        request: {
          method: c.req.method,
          path: c.req.path,
          url: c.req.url,
          headers: normalizeHeaders(c.req.raw.headers),
          body: requestBody,
        },
        response: {
          status: c.res.status,
          headers: normalizeHeaders(c.res.headers),
          body: responseBody,
        },
        ...(didCatchError
          ? {
              error:
                caughtError instanceof Error
                  ? {
                      name: caughtError.name,
                      message: caughtError.message,
                    }
                  : formatUnknownError(caughtError),
            }
          : {}),
      };
      emitLog(didCatchError ? "http_error" : "http", payload);
    }
  };
}

export function configureLogger(options?: Partial<RemoteLoggerOptions>): RemoteLoggerOptions {
  return toLoggerOptions(options);
}

export function logSseFrame(frameType: "data" | "control", payload: unknown): void {
  if (!activeLoggerOptions.logSse) {
    return;
  }
  emitLog("sse", {
    frameType,
    payload,
  });
}
