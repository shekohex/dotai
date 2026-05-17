import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../../utils/error-message.js";
import { resolveBrowserAccessUrl } from "../../utils/browser-access.js";
import { createNotifyAuthHeaders, resolveNotifyCredential } from "./auth.js";
import {
  createNotifyClient,
  type NotifyPublishFailure,
  type NotifyPublishSuccess,
} from "./client.js";
import { parseNotifyActionResponseEvent, parseNotifyPublishEvent } from "./events.js";
import { registerNotifyCommands } from "./commands.js";
import { resolveNotifySettings } from "./settings.js";
import {
  NOTIFY_ACTION_INVOKED_EVENT,
  NOTIFY_ACTION_RESPONSE_EVENT,
  NOTIFY_FAILED_EVENT,
  NOTIFY_PUBLISHED_EVENT,
  NOTIFY_PUBLISH_EVENT,
  NOTIFY_RECEIVED_EVENT,
  parseIncomingMessage,
  type NotifyAction,
  type NotifyActionInvokedEvent,
  type NotifyActionResponseEvent,
  type NotifyPublishPayload,
  type ResolvedNotifySettings,
} from "./types.js";

export type PendingCallback = {
  actionId: string;
  sourceExtension: string;
  callbackChannel: string;
  callbackPayload: unknown;
  replyChannel?: string;
  awaitResponse: boolean;
  timeoutMs: number;
};

type PublishOutcome = {
  successes: NotifyPublishSuccess[];
  failures: NotifyPublishFailure[];
};

type NotifyCallbackHandler = (args: {
  pi: ExtensionAPI;
  action: NotifyActionInvokedEvent;
}) => void | Promise<void>;

export interface NotifyCallbackActionOptions<TPayload = unknown> {
  key: string;
  label: string;
  payload?: TPayload;
  awaitResponse?: boolean;
  timeoutMs?: number;
  replyChannel?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  clear?: boolean;
}

const callbackHandlers = new Map<string, NotifyCallbackHandler>();

export function takePendingCallback(
  callbackEntries: Map<string, PendingCallback>,
  correlationId: string,
): PendingCallback | undefined {
  const pending = callbackEntries.get(correlationId);
  if (pending !== undefined) {
    callbackEntries.delete(correlationId);
  }
  return pending;
}

export async function invokeNotifyCallbackHandler(
  pi: ExtensionAPI,
  channel: string,
  event: NotifyActionInvokedEvent,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const directHandler = callbackHandlers.get(channel);
  if (directHandler === undefined) {
    return { ok: true };
  }
  try {
    await directHandler({ pi, action: event });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function normalizeHeaderRecord(headers: IncomingMessage["headers"]): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      normalized[key] = value.join(", ");
    }
  }
  return normalized;
}

function collectRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      resolve(body);
    });
    req.on("error", reject);
  });
}

function signValue(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function isValidSignature(secret: string, value: string, signature: string): boolean {
  const expected = signValue(secret, value);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function toStringMap(url: URL): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    result[key] = value;
  }
  return result;
}

function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

class NotifyRuntime {
  private currentCtx: ExtensionContext | undefined;
  private readonly settings: ResolvedNotifySettings;
  private readonly client = createNotifyClient();
  private callbackServer: Server | undefined;
  private callbackPublicBaseUrl: string | undefined;
  private readonly callbackEntries = new Map<string, PendingCallback>();
  private readonly pendingReplies = new Map<string, (value: NotifyActionResponseEvent) => void>();
  private subscriptionAbort: AbortController | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly pi: ExtensionAPI) {
    this.settings = resolveNotifySettings();
  }

  register(): void {
    registerNotifyCommands(this.pi);
    this.pi.on("session_start", (_event, ctx) => {
      this.currentCtx = ctx;
      this.startRuntime(ctx);
    });
    this.pi.on("session_shutdown", () => {
      this.stopRuntime();
      this.currentCtx = undefined;
    });
    this.pi.events.on(NOTIFY_PUBLISH_EVENT, (data) => {
      void this.handlePublishEvent(data);
    });
    this.pi.events.on(NOTIFY_ACTION_RESPONSE_EVENT, (data) => {
      const payload = parseNotifyActionResponseEvent(data);
      if (payload === null) {
        return;
      }
      const resolveReply = this.pendingReplies.get(payload.correlationId);
      if (resolveReply !== undefined) {
        resolveReply(payload);
      }
    });
  }

  private startRuntime(ctx: ExtensionContext): void {
    if (!this.settings.enabled) {
      return;
    }
    if (this.settings.subscribe?.enabled === true) {
      this.startSubscriptionLoop(ctx);
    }
  }

  private stopRuntime(): void {
    this.subscriptionAbort?.abort();
    this.subscriptionAbort = undefined;
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.callbackServer?.close();
    this.callbackServer = undefined;
    this.callbackPublicBaseUrl = undefined;
    this.callbackEntries.clear();
    this.pendingReplies.clear();
  }

  private async handlePublishEvent(data: unknown): Promise<void> {
    const payload = parseNotifyPublishEvent(data);
    const ctx = this.currentCtx;
    if (payload === null) {
      ctx?.ui.notify("notify publish event invalid", "warning");
      return;
    }
    try {
      const outcome = await this.publishPayload(payload, ctx);
      const hasInteractiveUi = ctx !== undefined && ctx.hasUI;
      if (hasInteractiveUi && outcome.failures.length > 0) {
        ctx.ui.notify(`notify failed: ${outcome.failures[0]?.error ?? "unknown"}`, "error");
      }
    } catch (error) {
      ctx?.ui.notify(`notify failed: ${errorMessage(error)}`, "error");
    }
  }

  private async publishPayload(
    payload: NotifyPublishPayload,
    ctx?: ExtensionContext,
  ): Promise<PublishOutcome> {
    const preparedPayload = await this.preparePayload(payload);
    const credential = await resolveNotifyCredential(ctx);
    const auth = createNotifyAuthHeaders(credential, this.settings.allowAnonymous);
    if (!auth.configured && !this.settings.allowAnonymous) {
      const failure: NotifyPublishFailure = {
        normalizedRequest: preparedPayload,
        attempts: 1,
        retryable: false,
        classification: "auth",
        error: "ntfy auth missing",
      };
      this.emitPublishFailure(payload, failure);
      return { successes: [], failures: [failure] };
    }

    const outcome = await this.client.publishMany({
      payload: preparedPayload,
      auth,
      settings: this.settings,
    });
    for (const success of outcome.successes) {
      this.pi.events.emit(NOTIFY_PUBLISHED_EVENT, {
        topic: success.topic,
        request: payload,
        normalizedRequest: success.normalizedRequest,
        response: success.response,
        timestamp: Date.now(),
      });
    }
    for (const failure of outcome.failures) {
      this.emitPublishFailure(payload, failure);
    }
    return outcome;
  }

  private emitPublishFailure(request: NotifyPublishPayload, failure: NotifyPublishFailure): void {
    this.pi.events.emit(NOTIFY_FAILED_EVENT, {
      topic: failure.topic,
      request,
      normalizedRequest: failure.normalizedRequest,
      error: failure.error,
      classification: failure.classification,
      retryable: failure.retryable,
      status: failure.status,
      attempts: failure.attempts,
      timestamp: Date.now(),
    });
  }

  private async preparePayload(payload: NotifyPublishPayload): Promise<NotifyPublishPayload> {
    if (payload.actions === undefined || payload.actions.length === 0) {
      return payload;
    }
    const preparedActions: NotifyAction[] = [];
    for (let index = 0; index < payload.actions.length; index += 1) {
      preparedActions.push(await this.prepareAction(payload.actions[index], payload, index));
    }
    return { ...payload, actions: preparedActions };
  }

  private async prepareAction(
    action: NotifyAction,
    payload: NotifyPublishPayload,
    index: number,
  ): Promise<NotifyAction> {
    const generatedId = `${payload.meta?.correlationId ?? "notify"}-${index + 1}`;
    if (action.action === "callback") {
      await this.ensureCallbackServer();
    }
    if (action.action === "http" && action.callback !== undefined) {
      await this.ensureCallbackServer();
    }
    if (
      action.action === "callback" &&
      this.callbackPublicBaseUrl !== undefined &&
      this.settings.callbackServer !== undefined
    ) {
      const actionId = action.id ?? generatedId;
      const sourceExtension = payload.meta?.sourceExtension ?? "unknown";
      const correlationId = `${payload.meta?.correlationId ?? actionId}-${Date.now()}`;
      const signature = signValue(
        this.settings.callbackServer.signingSecret,
        `${correlationId}:${actionId}`,
      );
      this.callbackEntries.set(correlationId, {
        actionId,
        sourceExtension,
        callbackChannel: action.key,
        callbackPayload: action.payload,
        replyChannel: action.replyChannel,
        awaitResponse: action.awaitResponse ?? false,
        timeoutMs: action.timeoutMs ?? 60 * 60 * 1_000,
      });

      const callbackUrl = new URL(this.callbackPublicBaseUrl);
      callbackUrl.pathname = "/notify/action";
      callbackUrl.searchParams.set("correlationId", correlationId);
      callbackUrl.searchParams.set("actionId", actionId);
      callbackUrl.searchParams.set("sig", signature);

      return {
        action: "http",
        id: actionId,
        label: action.label,
        clear: action.clear,
        url: callbackUrl.toString(),
        method: action.method ?? "POST",
        headers: undefined,
        body: undefined,
      };
    }
    if (
      action.action === "http" &&
      action.callback !== undefined &&
      this.callbackPublicBaseUrl !== undefined &&
      this.settings.callbackServer !== undefined
    ) {
      const actionId = action.id ?? generatedId;
      const sourceExtension = payload.meta?.sourceExtension ?? "unknown";
      const correlationId = `${payload.meta?.correlationId ?? actionId}-${Date.now()}`;
      const signature = signValue(
        this.settings.callbackServer.signingSecret,
        `${correlationId}:${actionId}`,
      );
      this.callbackEntries.set(correlationId, {
        actionId,
        sourceExtension,
        callbackChannel: action.callback.channel,
        callbackPayload: action.callback.payload,
        replyChannel: action.callback.replyChannel,
        awaitResponse: action.callback.awaitResponse ?? false,
        timeoutMs: action.callback.timeoutMs ?? 5_000,
      });

      const callbackUrl = new URL(this.callbackPublicBaseUrl);
      callbackUrl.pathname = "/notify/action";
      callbackUrl.searchParams.set("correlationId", correlationId);
      callbackUrl.searchParams.set("actionId", actionId);
      callbackUrl.searchParams.set("sig", signature);

      return {
        ...action,
        id: actionId,
        action: "http",
        url: callbackUrl.toString(),
        method: action.action === "http" ? (action.method ?? "POST") : "POST",
        headers: action.action === "http" ? action.headers : undefined,
        body: action.action === "http" ? action.body : undefined,
      };
    }

    if (action.id !== undefined) {
      return action;
    }
    return { ...action, id: generatedId };
  }

  private async ensureCallbackServer(): Promise<void> {
    if (this.callbackServer !== undefined) {
      return;
    }
    if (this.settings.callbackServer?.enabled !== true) {
      return;
    }
    const callbackServerSettings = this.settings.callbackServer;
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleCallbackRequest(req, res);
      });
      server.once("error", reject);
      server.listen(callbackServerSettings.port ?? 0, callbackServerSettings.host, () => {
        server.off("error", reject);
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("notify callback server failed to bind"));
          return;
        }
        const localUrl = `http://${callbackServerSettings.host}:${address.port}/`;
        this.callbackPublicBaseUrl = resolveBrowserAccessUrl({
          serverUrl: localUrl,
          port: address.port,
          publicBaseUrl: callbackServerSettings.publicBaseUrl,
        });
        this.callbackServer = server;
        resolve();
      });
    });
  }

  private async createSubscriptionHeaders(
    ctx: ExtensionContext,
  ): Promise<Record<string, string> | null> {
    const credential = await resolveNotifyCredential(ctx);
    const auth = createNotifyAuthHeaders(credential, this.settings.allowAnonymous);
    if (!auth.configured && !this.settings.allowAnonymous) {
      ctx.ui.notify("notify subscribe auth missing", "warning");
      return null;
    }
    return auth.headers;
  }

  private async handleCallbackRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== "/notify/action") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const correlationId = url.searchParams.get("correlationId") ?? "";
    const actionId = url.searchParams.get("actionId") ?? "";
    const signature = url.searchParams.get("sig") ?? "";
    const callbackServerSettings = this.settings.callbackServer;
    if (callbackServerSettings === undefined) {
      res.statusCode = 500;
      res.end("Callback server disabled");
      return;
    }
    if (
      !isValidSignature(
        callbackServerSettings.signingSecret,
        `${correlationId}:${actionId}`,
        signature,
      )
    ) {
      res.statusCode = 403;
      res.end("Invalid signature");
      return;
    }

    const pending = takePendingCallback(this.callbackEntries, correlationId);
    if (pending === undefined) {
      res.statusCode = 404;
      res.end("Unknown callback");
      return;
    }
    if (pending.actionId !== actionId) {
      res.statusCode = 404;
      res.end("Unknown callback");
      return;
    }

    const body = await collectRequestBody(req);
    const event: NotifyActionInvokedEvent = {
      correlationId,
      actionId,
      sourceExtension: pending.sourceExtension,
      callbackChannel: pending.callbackChannel,
      callbackPayload: pending.callbackPayload,
      replyChannel: pending.replyChannel,
      request: {
        method: req.method ?? "GET",
        path: url.pathname,
        query: toStringMap(url),
        headers: normalizeHeaderRecord(req.headers),
        body,
        timestamp: Date.now(),
      },
    };
    this.pi.events.emit(NOTIFY_ACTION_INVOKED_EVENT, event);
    const handlerResult = await invokeNotifyCallbackHandler(
      this.pi,
      pending.callbackChannel,
      event,
    );
    if (!handlerResult.ok) {
      res.statusCode = 500;
      res.end(`Callback handler failed: ${handlerResult.error}`);
      return;
    }

    if (!pending.awaitResponse) {
      res.statusCode = 202;
      res.end("Accepted");
      return;
    }

    const response = await this.waitForActionResponse(correlationId, pending.timeoutMs);
    if (response === null) {
      res.statusCode = 202;
      res.end("Accepted");
      return;
    }

    if (response.headers !== undefined) {
      for (const [key, value] of Object.entries(response.headers)) {
        res.setHeader(key, value);
      }
    }
    res.statusCode = response.statusCode ?? 200;
    res.end(response.body ?? "OK");
  }

  private waitForActionResponse(
    correlationId: string,
    timeoutMs: number,
  ): Promise<NotifyActionResponseEvent | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingReplies.delete(correlationId);
        resolve(null);
      }, timeoutMs);
      this.pendingReplies.set(correlationId, (value) => {
        clearTimeout(timeout);
        this.pendingReplies.delete(correlationId);
        resolve(value);
      });
    });
  }

  private startSubscriptionLoop(ctx: ExtensionContext): void {
    if (this.settings.subscribe?.enabled !== true || this.subscriptionAbort !== undefined) {
      return;
    }
    this.subscriptionAbort = new AbortController();
    if (this.settings.subscribe.mode === "ws") {
      ctx.ui.notify("notify subscribe mode ws not implemented, using json", "warning");
    }
    if (this.settings.subscribe.mode === "sse") {
      void this.streamTopics(ctx, "sse");
      return;
    }
    if (this.settings.subscribe.poll) {
      void this.pollTopics(ctx);
      return;
    }
    void this.streamTopics(ctx, "json");
  }

  private async pollTopics(ctx: ExtensionContext): Promise<void> {
    const subscribe = this.settings.subscribe;
    if (subscribe === undefined || this.subscriptionAbort === undefined) {
      return;
    }
    const headers = await this.createSubscriptionHeaders(ctx);
    if (headers === null) {
      return;
    }
    for (const topic of subscribe.topics) {
      await this.fetchTopicMessages(ctx, topic, true, headers);
    }
    this.pollTimer = setTimeout(() => {
      void this.pollTopics(ctx);
    }, subscribe.pollIntervalMs);
  }

  private async streamTopics(ctx: ExtensionContext, mode: "json" | "sse"): Promise<void> {
    const subscribe = this.settings.subscribe;
    const controller = this.subscriptionAbort;
    if (subscribe === undefined || controller === undefined) {
      return;
    }
    const headers = await this.createSubscriptionHeaders(ctx);
    if (headers === null) {
      return;
    }

    await Promise.all(
      subscribe.topics.map(async (topic) => {
        const since = subscribe.since === undefined ? "all" : String(subscribe.since);
        const endpoint = mode === "sse" ? "sse" : "json";
        const url = `${this.settings.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(topic)}/${endpoint}?since=${encodeURIComponent(since)}`;
        try {
          const response = await fetch(url, { headers, signal: controller.signal });
          if (!response.ok || response.body === null) {
            throw new Error(`subscribe failed ${response.status}`);
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            const split = splitLines(buffer);
            buffer = split.rest;
            for (const line of split.lines) {
              this.handleIncomingLine(topic, line, mode);
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            ctx.ui.notify(`notify subscribe failed: ${errorMessage(error)}`, "warning");
          }
        }
      }),
    );
  }

  private async fetchTopicMessages(
    ctx: ExtensionContext,
    topic: string,
    poll: boolean,
    headers: Record<string, string>,
  ): Promise<void> {
    const subscribe = this.settings.subscribe;
    if (subscribe === undefined || this.subscriptionAbort === undefined) {
      return;
    }
    const params = new URLSearchParams();
    params.set("poll", poll ? "1" : "0");
    params.set("since", subscribe.since === undefined ? "all" : String(subscribe.since));
    const url = `${this.settings.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(topic)}/json?${params.toString()}`;
    try {
      const response = await fetch(url, { headers, signal: this.subscriptionAbort.signal });
      if (!response.ok) {
        throw new Error(`subscribe failed ${response.status}`);
      }
      const body = await response.text();
      for (const line of body.split(/\r?\n/)) {
        this.handleIncomingLine(topic, line, "json");
      }
    } catch (error) {
      if (!this.subscriptionAbort.signal.aborted) {
        ctx.ui.notify(`notify subscribe failed: ${errorMessage(error)}`, "warning");
      }
    }
  }

  private handleIncomingLine(topic: string, line: string, mode: "json" | "sse"): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      const parsedUnknown = this.parseIncomingPayload(trimmed, mode);
      if (parsedUnknown === null) {
        return;
      }
      const parsed = parseIncomingMessage(parsedUnknown);
      if (parsed === null) {
        return;
      }
      this.pi.events.emit(NOTIFY_RECEIVED_EVENT, {
        receivedAt: Date.now(),
        topic,
        message: { ...parsed, raw: parsed.raw ?? parsedUnknown },
      });
    } catch {}
  }

  private parseIncomingPayload(line: string, mode: "json" | "sse"): unknown {
    if (mode === "json") {
      return JSON.parse(line) as unknown;
    }
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      return payload.length > 0 ? (JSON.parse(payload) as unknown) : null;
    }
    return null;
  }
}

export function emitNotifyPublish(pi: ExtensionAPI, payload: NotifyPublishPayload): void {
  pi.events.emit(NOTIFY_PUBLISH_EVENT, payload);
}

export function publishNotify(
  pi: ExtensionAPI,
  payload: NotifyPublishPayload,
  options?: {
    onAction?: NotifyCallbackHandler;
  },
): void {
  const onAction = options?.onAction;
  if (onAction !== undefined && payload.actions !== undefined) {
    const nextActions = payload.actions.map((action, index) => {
      if (action.action === "callback") {
        const channel = `${payload.meta?.sourceExtension ?? "notify"}:${payload.meta?.correlationId ?? Date.now().toString()}:${index}`;
        callbackHandlers.set(channel, onAction);
        return {
          ...action,
          key: channel,
        };
      }
      if (action.callback === undefined) {
        return action;
      }
      const channel = `${payload.meta?.sourceExtension ?? "notify"}:${payload.meta?.correlationId ?? Date.now().toString()}:${index}`;
      callbackHandlers.set(channel, onAction);
      return {
        ...action,
        callback: {
          ...action.callback,
          channel,
        },
      };
    });
    pi.events.emit(NOTIFY_PUBLISH_EVENT, { ...payload, actions: nextActions });
    return;
  }
  pi.events.emit(NOTIFY_PUBLISH_EVENT, payload);
}

export function createNotifyCallbackAction<TPayload = unknown>(
  options: NotifyCallbackActionOptions<TPayload>,
): NotifyAction {
  return {
    action: "callback",
    key: options.key,
    label: options.label,
    payload: options.payload,
    awaitResponse: options.awaitResponse,
    timeoutMs: options.timeoutMs,
    replyChannel: options.replyChannel,
    method: options.method,
    clear: options.clear,
  };
}

export default function notifyExtension(pi: ExtensionAPI): void {
  new NotifyRuntime(pi).register();
}
