import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../../utils/error-message.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type FetchJsonOptions = {
  method?: "GET" | "POST";
  timeoutMs?: number;
  body?: JsonObject;
};

export class HttpError extends Error {
  readonly baseUrl: string;
  readonly path: string;
  readonly status?: number;
  readonly bodyText?: string;

  constructor(input: {
    baseUrl: string;
    path: string;
    message: string;
    status?: number;
    bodyText?: string;
  }) {
    super(input.message);
    this.name = "HttpError";
    this.baseUrl = input.baseUrl;
    this.path = input.path;
    this.status = input.status;
    this.bodyText = input.bodyText;
  }
}

const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const EXECUTOR_AUTH_PROVIDER = "executor";

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (typeof value === "object") {
    return Object.values(value).every((item) => isJsonValue(item));
  }

  return false;
};

const parseJson = async (response: Response): Promise<JsonValue> => {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isJsonValue(parsed)) {
      throw new TypeError("invalid json value");
    }
    return parsed;
  } catch {
    throw new HttpError({
      baseUrl: new URL(response.url).origin,
      path: new URL(response.url).pathname,
      message: `Executor returned invalid JSON from ${response.url}`,
      status: response.status,
      bodyText: text,
    });
  }
};

export const fetchJson = async <T>(
  baseUrl: string,
  path: string,
  parse: (value: JsonValue) => T,
  options: FetchJsonOptions = {},
): Promise<T> => {
  const url = new URL(path, baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);

  try {
    const response = await requestJson(baseUrl, path, url, options, controller.signal);
    const json = await parseJson(response);
    return parse(json);
  } catch (error) {
    throw toHttpError(baseUrl, path, error);
  } finally {
    clearTimeout(timeout);
  }
};

export async function resolveExecutorAuthorizationHeaders(): Promise<Record<string, string>> {
  const apiKey = await AuthStorage.create().getApiKey(EXECUTOR_AUTH_PROVIDER, {
    includeFallback: false,
  });

  if (apiKey === undefined || apiKey.length === 0) {
    return {};
  }

  return { Authorization: `Bearer ${apiKey}` };
}

async function requestJson(
  baseUrl: string,
  path: string,
  url: URL,
  options: FetchJsonOptions,
  signal: AbortSignal,
): Promise<Response> {
  const headers = await resolveExecutorAuthorizationHeaders();
  if (options.body) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal,
  });

  if (response.ok) {
    return response;
  }

  const bodyText = await response.text().catch(() => "");
  throw new HttpError({
    baseUrl,
    path,
    message: `Executor HTTP ${response.status} from ${path}`,
    status: response.status,
    bodyText,
  });
}

function toHttpError(baseUrl: string, path: string, error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return new HttpError({
      baseUrl,
      path,
      message: `Executor request to ${path} timed out`,
    });
  }

  const message = errorMessage(error);
  return new HttpError({
    baseUrl,
    path,
    message: `Executor request to ${path} failed: ${message}`,
  });
}

const parseIntegrationsProbe = (value: JsonValue): true => {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected integrations response to be an array");
  }

  return true;
};

export const probeExecutorApi = (baseUrl: string, timeoutMs?: number): Promise<true> =>
  fetchJson(baseUrl, "/api/integrations", parseIntegrationsProbe, { timeoutMs });
