import type { NotifyAuthHeadersResult } from "./auth.js";
import { errorMessage } from "../../utils/error-message.js";
import type { NotifyAction, NotifyPublishPayload, ResolvedNotifySettings } from "./types.js";

export interface NotifyPublishRequest {
  payload: NotifyPublishPayload;
  auth: NotifyAuthHeadersResult;
  settings: ResolvedNotifySettings;
}

export interface NotifyPublishSuccess {
  topic: string;
  normalizedRequest: NotifyPublishPayload;
  response: {
    status: number;
    body: string;
  };
}

export interface NotifyPublishFailure {
  topic?: string;
  normalizedRequest: NotifyPublishPayload;
  status?: number;
  attempts: number;
  retryable: boolean;
  classification: "network" | "http" | "config" | "auth" | "validation" | "unknown";
  error: string;
}

export interface NotifyClient {
  publishMany(request: NotifyPublishRequest): Promise<{
    successes: NotifyPublishSuccess[];
    failures: NotifyPublishFailure[];
  }>;
}

function normalizeTopics(topic: NotifyPublishPayload["topic"]): string[] {
  return Array.isArray(topic) ? [...new Set(topic)] : [topic];
}

function normalizeTags(
  payload: NotifyPublishPayload,
  settings: ResolvedNotifySettings,
): string[] | undefined {
  const tags = [...settings.defaultTags, ...(payload.tags ?? [])].filter((value, index, all) => {
    return value.length > 0 && all.indexOf(value) === index;
  });
  return tags.length > 0 ? tags : undefined;
}

export function normalizePublishPayload(
  payload: NotifyPublishPayload,
  settings: ResolvedNotifySettings,
): NotifyPublishPayload {
  return {
    ...payload,
    topic: Array.isArray(payload.topic) ? payload.topic : [payload.topic],
    priority: payload.priority ?? settings.defaultPriority,
    tags: normalizeTags(payload, settings),
  };
}

function jitterDelay(ms: number): number {
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(ms / 4)));
  return ms + jitter;
}

function isRetryableStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function classifyFailure(status?: number, error?: unknown): NotifyPublishFailure["classification"] {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status !== undefined) {
    return "http";
  }
  if (error instanceof TypeError) {
    return "network";
  }
  return "unknown";
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

function toNtfyBoolean(
  value: boolean | undefined,
  trueValue: string,
  falseValue: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value ? trueValue : falseValue;
}

function toNtfyAction(action: NotifyAction): Record<string, unknown> {
  if (action.action === "view") {
    return { action: "view", label: action.label, url: action.url, clear: action.clear };
  }
  if (action.action === "http") {
    return {
      action: "http",
      label: action.label,
      url: action.url,
      method: action.method,
      headers: action.headers,
      body: action.body,
      clear: action.clear,
    };
  }
  if (action.action === "callback") {
    return {
      action: "http",
      label: action.label,
      clear: action.clear,
    };
  }
  if (action.action === "broadcast") {
    return {
      action: "broadcast",
      label: action.label,
      intent: action.intent,
      extras: action.extras,
      clear: action.clear,
    };
  }
  return { action: "copy", label: action.label, value: action.value, clear: action.clear };
}

export function buildPublishBody(
  payload: NotifyPublishPayload,
  topic: string,
): Record<string, unknown> {
  const firebase = toNtfyBoolean(payload.firebase, "yes", "no");
  const unifiedpush = toNtfyBoolean(payload.unifiedPush, "1", "0");

  return {
    topic,
    message: payload.message,
    title: payload.title,
    priority: payload.priority,
    tags: payload.tags,
    markdown: payload.markdown,
    click: payload.click,
    attach: payload.attach,
    filename: payload.filename,
    icon: payload.icon,
    delay: payload.delay,
    email: payload.email,
    call: payload.call,
    cache: payload.cache,
    firebase,
    unifiedpush,
    actions: payload.actions?.map(toNtfyAction),
    sequence_id: payload.sequenceId,
  };
}

export function createNotifyClient(fetchImpl: typeof fetch = fetch): NotifyClient {
  return {
    async publishMany(request) {
      const normalized = normalizePublishPayload(request.payload, request.settings);
      const topics = normalizeTopics(normalized.topic);
      const successes: NotifyPublishSuccess[] = [];
      const failures: NotifyPublishFailure[] = [];
      for (const topic of topics) {
        const result = await publishTopic(fetchImpl, request, normalized, topic);
        if ("response" in result) {
          successes.push(result);
        } else {
          failures.push(result);
        }
      }
      return { successes, failures };
    },
  };
}

async function publishTopic(
  fetchImpl: typeof fetch,
  request: NotifyPublishRequest,
  normalized: NotifyPublishPayload,
  topic: string,
): Promise<NotifyPublishSuccess | NotifyPublishFailure> {
  let attempts = 0;
  while (attempts < request.settings.retryMaxAttempts) {
    attempts += 1;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, request.settings.publishTimeoutMs);
      const response = await fetchImpl(`${request.settings.baseUrl.replace(/\/$/, "")}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...request.auth.headers,
        },
        body: JSON.stringify(buildPublishBody(normalized, topic)),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const body = await response.text();
      if (response.ok) {
        return {
          topic,
          normalizedRequest: normalized,
          response: { status: response.status, body },
        };
      }

      const retryable = isRetryableStatus(response.status);
      if (retryable && attempts < request.settings.retryMaxAttempts) {
        await sleep(jitterDelay(request.settings.retryBaseDelayMs * 2 ** (attempts - 1)));
        continue;
      }

      return {
        topic,
        normalizedRequest: normalized,
        status: response.status,
        attempts,
        retryable,
        classification: classifyFailure(response.status),
        error: body.length > 0 ? body : `HTTP ${response.status}`,
      };
    } catch (error) {
      if (attempts < request.settings.retryMaxAttempts) {
        await sleep(jitterDelay(request.settings.retryBaseDelayMs * 2 ** (attempts - 1)));
        continue;
      }
      return {
        topic,
        normalizedRequest: normalized,
        attempts,
        retryable: false,
        classification: classifyFailure(undefined, error),
        error: errorMessage(error),
      };
    }
  }

  return {
    topic,
    normalizedRequest: normalized,
    attempts: request.settings.retryMaxAttempts,
    retryable: false,
    classification: "unknown",
    error: "Publish attempts exhausted",
  };
}
