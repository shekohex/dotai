import { createHash } from "node:crypto";
import {
  formatThrownValue,
  registerSessionResourceCleanup,
  type ProviderEnv,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { WebSocket, type Data } from "ws";
import { isUnknownRecord, parseUnknownJson } from "../../utils/unknown-value.js";
import { resolveHttpProxyUrlForTarget } from "./responses-websocket-proxy.js";

// Ported from pi-ai's openai-codex-responses transport; keep cache and fallback semantics aligned.
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

const WebSocketEventSchema = Type.Object(
  {
    type: Type.String(),
    code: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    error: Type.Optional(Type.Unknown()),
    response: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

type WebSocketEvent = Static<typeof WebSocketEventSchema>;

export interface RequestBody extends Record<string, unknown> {
  input?: unknown[];
  previous_response_id?: string;
}

export interface CachedWebSocketContinuationState {
  lastRequestBody: RequestBody;
  lastResponseId: string;
  lastResponseItems: unknown[];
}

interface CachedWebSocketConnection {
  socket: WebSocket;
  busy: boolean;
  createdAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  continuation?: CachedWebSocketContinuationState;
}

export interface LiteLLMWebSocketDebugStats {
  requests: number;
  connectionsCreated: number;
  connectionsReused: number;
  cachedContextRequests: number;
  fullContextRequests: number;
  deltaRequests: number;
  lastInputItems: number;
  lastDeltaInputItems?: number;
  lastPreviousResponseId?: string;
  websocketFailures: number;
  sseFallbacks: number;
  websocketFallbackActive?: boolean;
  lastWebSocketError?: string;
}

export interface LiteLLMWebSocketOperation {
  response: Response;
  entry?: CachedWebSocketConnection;
  fullBody: RequestBody;
  responseId?: string;
}

interface WebSocketLease {
  socket: WebSocket;
  entry?: CachedWebSocketConnection;
  reused: boolean;
  release(options?: { keep?: boolean }): void;
}

export class LiteLLMApiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "LiteLLMApiError";
    this.code = code;
  }
}

function webSocketCloseError(message: string): Error {
  const error = new Error(message);
  error.name = "WebSocketCloseError";
  return error;
}

const websocketSessionCache = new Map<string, Map<string, CachedWebSocketConnection>>();
const websocketDebugStats = new Map<string, LiteLLMWebSocketDebugStats>();
const websocketSseFallbackSessions = new Set<string>();

export function resolveWebSocketUrl(httpUrl: string, modelId: string): string {
  const url = new URL(httpUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error(`Unsupported LiteLLM Responses URL protocol: ${url.protocol}`);
  url.searchParams.set("model", modelId);
  return url.toString();
}

function isWebSocketHandshakeHeader(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName !== "accept" &&
    normalizedName !== "connection" &&
    normalizedName !== "content-length" &&
    normalizedName !== "content-type" &&
    normalizedName !== "host" &&
    normalizedName !== "upgrade" &&
    !normalizedName.startsWith("sec-websocket-")
  );
}

export function webSocketHeaders(headers: ProviderHeaders | Headers): Record<string, string> {
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        );
  return Object.fromEntries(entries.filter(([name]) => isWebSocketHandshakeHeader(name)));
}

function connectionKey(url: string, headers: Record<string, string>): string {
  const normalizedHeaders = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .toSorted(([first], [second]) => first.localeCompare(second));
  return createHash("sha256")
    .update(JSON.stringify({ url, headers: normalizedHeaders }))
    .digest("hex");
}

function getOrCreateWebSocketDebugStats(sessionId: string): LiteLLMWebSocketDebugStats {
  let stats = websocketDebugStats.get(sessionId);
  if (stats === undefined) {
    stats = {
      requests: 0,
      connectionsCreated: 0,
      connectionsReused: 0,
      cachedContextRequests: 0,
      fullContextRequests: 0,
      deltaRequests: 0,
      lastInputItems: 0,
      websocketFailures: 0,
      sseFallbacks: 0,
    };
    websocketDebugStats.set(sessionId, stats);
  }
  return stats;
}

export function getLiteLLMWebSocketDebugStats(
  sessionId: string,
): LiteLLMWebSocketDebugStats | undefined {
  const stats = websocketDebugStats.get(sessionId);
  return stats === undefined ? undefined : { ...stats };
}

export function resetLiteLLMWebSocketDebugStats(sessionId?: string): void {
  if (sessionId !== undefined) {
    websocketDebugStats.delete(sessionId);
    websocketSseFallbackSessions.delete(sessionId);
    return;
  }
  websocketDebugStats.clear();
  websocketSseFallbackSessions.clear();
}

function closeWebSocketSilently(socket: WebSocket, code = 1000, reason = "done"): void {
  try {
    socket.close(code, reason);
  } catch {}
}

function closeEntry(entry: CachedWebSocketConnection, reason: string): void {
  if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  closeWebSocketSilently(entry.socket, 1000, reason);
}

export function closeLiteLLMWebSocketSessions(sessionId?: string): void {
  if (sessionId !== undefined) {
    for (const entry of websocketSessionCache.get(sessionId)?.values() ?? []) {
      closeEntry(entry, "session_cleanup");
    }
    websocketSessionCache.delete(sessionId);
    return;
  }
  for (const entries of websocketSessionCache.values()) {
    for (const entry of entries.values()) closeEntry(entry, "session_cleanup");
  }
  websocketSessionCache.clear();
}

registerSessionResourceCleanup(closeLiteLLMWebSocketSessions);

export function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
  return sessionId === undefined ? false : websocketSseFallbackSessions.has(sessionId);
}

export function recordWebSocketSseFallback(sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  const stats = getOrCreateWebSocketDebugStats(sessionId);
  stats.sseFallbacks += 1;
  stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

export function recordWebSocketFailure(sessionId: string | undefined, error: unknown): void {
  if (sessionId === undefined) return;
  websocketSseFallbackSessions.add(sessionId);
  const stats = getOrCreateWebSocketDebugStats(sessionId);
  stats.websocketFailures += 1;
  stats.lastWebSocketError = formatThrownValue(error);
  stats.websocketFallbackActive = true;
}

function isWebSocketReusable(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}

function isWebSocketSessionExpired(entry: CachedWebSocketConnection): boolean {
  return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

function removeCachedEntry(sessionId: string, key: string, entry: CachedWebSocketConnection): void {
  const entries = websocketSessionCache.get(sessionId);
  if (entries?.get(key) === entry) entries.delete(key);
  if (entries?.size === 0) websocketSessionCache.delete(sessionId);
}

function scheduleSessionWebSocketExpiry(
  sessionId: string,
  key: string,
  entry: CachedWebSocketConnection,
): void {
  if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) return;
    closeEntry(entry, "idle_timeout");
    removeCachedEntry(sessionId, key, entry);
  }, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

function proxyAgent(
  url: string,
  env?: ProviderEnv,
): HttpProxyAgent<string> | HttpsProxyAgent<string> | undefined {
  const proxyUrl = resolveHttpProxyUrlForTarget(
    url.replace(/^wss:/u, "https:").replace(/^ws:/u, "http:"),
    env,
  );
  if (proxyUrl === undefined) return undefined;
  return url.startsWith("wss:") ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl);
}

function connectWebSocket(params: {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  env?: ProviderEnv;
}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(params.url, {
      headers: params.headers,
      handshakeTimeout: params.connectTimeoutMs ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
      agent: proxyAgent(params.url, params.env),
    });
    const cleanup = (): void => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      params.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error, reason?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (reason !== undefined) closeWebSocketSilently(socket, 1000, reason);
      reject(error);
    };
    const onOpen = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (event: { error?: unknown; message: string }): void => {
      const nestedError = event.error instanceof Error ? event.error : undefined;
      fail(nestedError ?? new Error(event.message || "WebSocket error"));
    };
    const onClose = (event: { code: number; reason: string }): void => {
      fail(webSocketCloseError(`WebSocket closed ${event.code} ${event.reason}`.trim()));
    };
    const onAbort = (): void => {
      fail(new Error("Request was aborted"), "aborted");
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted === true) onAbort();
  });
}

function createCachedLease(
  sessionId: string,
  key: string,
  entry: CachedWebSocketConnection,
  reused: boolean,
): WebSocketLease {
  return {
    socket: entry.socket,
    entry,
    reused,
    release: ({ keep } = {}) => {
      if (keep !== true || !isWebSocketReusable(entry.socket)) {
        closeEntry(entry, "done");
        removeCachedEntry(sessionId, key, entry);
        return;
      }
      entry.busy = false;
      scheduleSessionWebSocketExpiry(sessionId, key, entry);
    },
  };
}

function closeChangedConnections(sessionId: string, key: string): void {
  const entries = websocketSessionCache.get(sessionId);
  if (entries === undefined) return;
  for (const [candidateKey, entry] of entries) {
    if (candidateKey === key || entry.busy) continue;
    closeEntry(entry, "connection_identity_changed");
    entries.delete(candidateKey);
  }
  if (entries.size === 0) websocketSessionCache.delete(sessionId);
}

async function acquireWebSocket(params: {
  url: string;
  headers: Record<string, string>;
  sessionId?: string;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  env?: ProviderEnv;
}): Promise<WebSocketLease> {
  const key = connectionKey(params.url, params.headers);
  if (params.sessionId === undefined) {
    const socket = await connectWebSocket(params);
    return {
      socket,
      reused: false,
      release: () => {
        closeWebSocketSilently(socket);
      },
    };
  }

  closeChangedConnections(params.sessionId, key);
  const cached = websocketSessionCache.get(params.sessionId)?.get(key);
  if (cached !== undefined) {
    if (cached.idleTimer !== undefined) clearTimeout(cached.idleTimer);
    cached.idleTimer = undefined;
    if (!cached.busy && isWebSocketSessionExpired(cached)) {
      closeEntry(cached, "connection_age_limit");
      removeCachedEntry(params.sessionId, key, cached);
    } else if (!cached.busy && isWebSocketReusable(cached.socket)) {
      cached.busy = true;
      return createCachedLease(params.sessionId, key, cached, true);
    } else if (cached.busy) {
      const socket = await connectWebSocket(params);
      return {
        socket,
        reused: false,
        release: () => {
          closeWebSocketSilently(socket);
        },
      };
    } else {
      closeEntry(cached, "not_reusable");
      removeCachedEntry(params.sessionId, key, cached);
    }
  }

  const socket = await connectWebSocket(params);
  const entry: CachedWebSocketConnection = { socket, busy: true, createdAt: Date.now() };
  let entries = websocketSessionCache.get(params.sessionId);
  if (entries === undefined) {
    entries = new Map();
    websocketSessionCache.set(params.sessionId, entries);
  }
  entries.set(key, entry);
  return createCachedLease(params.sessionId, key, entry, false);
}

function decodeWebSocketData(data: Data): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function parseWebSocketEvent(data: Data): WebSocketEvent {
  const text = decodeWebSocketData(data);
  const parsed = parseUnknownJson(text);
  if (!Value.Check(WebSocketEventSchema, parsed)) {
    throw new Error("Invalid LiteLLM Responses WebSocket event");
  }
  return Value.Parse(WebSocketEventSchema, parsed);
}

function eventError(event: WebSocketEvent): { code?: string; message?: string } {
  const nested = isUnknownRecord(event.error) ? event.error : undefined;
  return {
    code: event.code ?? (typeof nested?.code === "string" ? nested.code : undefined),
    message: event.message ?? (typeof nested?.message === "string" ? nested.message : undefined),
  };
}

function normalizeWebSocketEvent(event: WebSocketEvent): WebSocketEvent {
  if (event.type === "error") {
    const error = eventError(event);
    throw new LiteLLMApiError(
      `LiteLLM error: ${error.message ?? error.code ?? JSON.stringify(event)}`,
      error.code,
    );
  }
  if (event.type === "response.failed") {
    const response = isUnknownRecord(event.response) ? event.response : undefined;
    const error = isUnknownRecord(response?.error) ? response.error : undefined;
    throw new LiteLLMApiError(
      typeof error?.message === "string" ? error.message : "LiteLLM response failed",
      typeof error?.code === "string" ? error.code : undefined,
    );
  }
  if (
    event.type === "response.done" ||
    event.type === "response.completed" ||
    event.type === "response.incomplete"
  ) {
    return { ...event, type: "response.completed" };
  }
  return event;
}

async function* parseWebSocket(
  socket: WebSocket,
  signal?: AbortSignal,
  idleTimeoutMs?: number,
): AsyncGenerator<WebSocketEvent> {
  const queue: WebSocketEvent[] = [];
  let pending: (() => void) | undefined;
  let done = false;
  let failed: Error | undefined;
  let sawCompletion = false;

  const wake = (): void => {
    const resolve = pending;
    pending = undefined;
    resolve?.();
  };
  const onMessage = (event: { data: Data }): void => {
    try {
      const parsed = parseWebSocketEvent(event.data);
      if (
        parsed.type === "response.completed" ||
        parsed.type === "response.done" ||
        parsed.type === "response.incomplete"
      ) {
        sawCompletion = true;
        done = true;
      }
      queue.push(parsed);
      wake();
    } catch (error) {
      failed = error instanceof Error ? error : new Error(formatThrownValue(error));
      done = true;
      wake();
    }
  };
  const onError = (event: { error?: unknown; message: string }): void => {
    failed = event.error instanceof Error ? event.error : new Error(event.message);
    done = true;
    wake();
  };
  const onClose = (event: { code: number; reason: string }): void => {
    if (!sawCompletion && failed === undefined) {
      const reason =
        event.reason ||
        (event.code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE ? "message too big" : "");
      failed = webSocketCloseError(`WebSocket closed ${event.code} ${reason}`.trim());
    }
    done = true;
    wake();
  };
  const onAbort = (): void => {
    failed = new Error("Request was aborted");
    done = true;
    wake();
  };
  const waitForEvent = async (): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve, reject) => {
      pending = resolve;
      if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
        timeout = setTimeout(() => {
          const error = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
          failed = error;
          done = true;
          pending = undefined;
          closeWebSocketSilently(socket, 1000, "idle_timeout");
          reject(error);
        }, idleTimeoutMs);
      }
    }).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort);
  try {
    while (true) {
      if (signal?.aborted === true) throw new Error("Request was aborted");
      const next = queue.shift();
      if (next !== undefined) {
        yield normalizeWebSocketEvent(next);
        continue;
      }
      if (done) break;
      await waitForEvent();
    }
    if (failed !== undefined) throw new Error(failed.message, { cause: failed });
    if (!sawCompletion) throw new Error("WebSocket stream closed before response.completed");
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

function requestBodyWithoutInput(body: RequestBody): RequestBody {
  const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
}

function responseInputsEqual(first: unknown[] | undefined, second: unknown[] | undefined): boolean {
  return JSON.stringify(first ?? []) === JSON.stringify(second ?? []);
}

function requestBodiesMatchExceptInput(first: RequestBody, second: RequestBody): boolean {
  return (
    JSON.stringify(requestBodyWithoutInput(first)) ===
    JSON.stringify(requestBodyWithoutInput(second))
  );
}

function getCachedWebSocketInputDelta(
  body: RequestBody,
  continuation: CachedWebSocketContinuationState,
): unknown[] | undefined {
  if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) return undefined;
  const currentInput = body.input ?? [];
  const baseline = [
    ...(continuation.lastRequestBody.input ?? []),
    ...continuation.lastResponseItems,
  ];
  if (currentInput.length < baseline.length) return undefined;
  if (!responseInputsEqual(currentInput.slice(0, baseline.length), baseline)) return undefined;
  return currentInput.slice(baseline.length);
}

export function buildCachedRequestBody(
  continuation: CachedWebSocketContinuationState | undefined,
  body: RequestBody,
): RequestBody {
  if (continuation === undefined) return body;
  const delta = getCachedWebSocketInputDelta(body, continuation);
  if (delta === undefined || continuation.lastResponseId.length === 0) return body;
  return { ...body, previous_response_id: continuation.lastResponseId, input: delta };
}

function responseId(event: WebSocketEvent): string | undefined {
  if (event.type !== "response.completed" || !isUnknownRecord(event.response)) return undefined;
  return typeof event.response.id === "string" ? event.response.id : undefined;
}

function sseFrame(event: WebSocketEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function recordRequestStats(
  sessionId: string | undefined,
  body: RequestBody,
  reused: boolean,
  cachedContext: boolean,
): void {
  if (sessionId === undefined) return;
  const stats = getOrCreateWebSocketDebugStats(sessionId);
  stats.requests += 1;
  if (reused) stats.connectionsReused += 1;
  else stats.connectionsCreated += 1;
  if (cachedContext) stats.cachedContextRequests += 1;
  stats.lastInputItems = body.input?.length ?? 0;
  if (body.previous_response_id === undefined) {
    stats.fullContextRequests += 1;
    stats.lastDeltaInputItems = undefined;
    stats.lastPreviousResponseId = undefined;
  } else {
    stats.deltaRequests += 1;
    stats.lastDeltaInputItems = body.input?.length ?? 0;
    stats.lastPreviousResponseId = body.previous_response_id;
  }
}

export async function createLiteLLMWebSocketOperation(params: {
  httpUrl: string;
  body: RequestBody;
  headers: Record<string, string>;
  modelId: string;
  sessionId?: string;
  useCachedContext: boolean;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  env?: ProviderEnv;
}): Promise<LiteLLMWebSocketOperation> {
  const url = resolveWebSocketUrl(params.httpUrl, params.modelId);
  const lease = await acquireWebSocket({
    url,
    headers: params.headers,
    sessionId: params.sessionId,
    signal: params.signal,
    connectTimeoutMs: params.connectTimeoutMs,
    env: params.env,
  });
  const requestBody = params.useCachedContext
    ? buildCachedRequestBody(lease.entry?.continuation, params.body)
    : params.body;
  recordRequestStats(params.sessionId, requestBody, lease.reused, params.useCachedContext);
  const operation: LiteLLMWebSocketOperation = {
    response: new Response(),
    entry: lease.entry,
    fullBody: params.body,
  };

  try {
    lease.socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
    const iterator = parseWebSocket(lease.socket, params.signal, params.idleTimeoutMs)[
      Symbol.asyncIterator
    ]();
    const first = await iterator.next();
    if (first.done === true) throw new Error("WebSocket stream closed before its first event");
    operation.responseId = responseId(first.value);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseFrame(first.value));
        void (async () => {
          try {
            while (true) {
              const next = await iterator.next();
              if (next.done === true) break;
              operation.responseId = responseId(next.value) ?? operation.responseId;
              controller.enqueue(sseFrame(next.value));
            }
            controller.close();
            lease.release({ keep: true });
          } catch (error) {
            if (lease.entry !== undefined) lease.entry.continuation = undefined;
            lease.release({ keep: false });
            controller.error(error);
          }
        })();
      },
      cancel() {
        if (lease.entry !== undefined) lease.entry.continuation = undefined;
        lease.release({ keep: false });
      },
    });
    operation.response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    return operation;
  } catch (error) {
    if (lease.entry !== undefined) lease.entry.continuation = undefined;
    lease.release({ keep: false });
    throw error instanceof Error ? error : new Error(formatThrownValue(error));
  }
}

export function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
  return error instanceof LiteLLMApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

export function isPreviousResponseNotFoundError(error: unknown): boolean {
  return error instanceof LiteLLMApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

export function completeLiteLLMWebSocketOperation(
  operation: LiteLLMWebSocketOperation | undefined,
  responseItems: unknown[],
): void {
  if (operation?.entry === undefined || operation.responseId === undefined) return;
  operation.entry.continuation = {
    lastRequestBody: operation.fullBody,
    lastResponseId: operation.responseId,
    lastResponseItems: responseItems,
  };
}

export function failLiteLLMWebSocketOperation(
  operation: LiteLLMWebSocketOperation | undefined,
): void {
  if (operation?.entry === undefined) return;
  operation.entry.continuation = undefined;
  closeWebSocketSilently(operation.entry.socket, 1000, "request_failed");
}
