import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  isRunningInCoderWorkspace,
  resolveCoderPublicBaseUrl,
} from "../../../utils/browser-access.js";
import {
  encodePairingUri,
  LIVE_PAIRING_PROTOCOL_VERSION,
  parseJsonRpcMessage,
  parsePairRequestParams,
  type JsonRpcId,
  type LivePairingEndpoint,
  type PairingDescriptor,
  type PairingPayload,
} from "./schemas.js";

const DEFAULT_PAIRING_TTL_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

export type LivePairingMode = "auto" | "local" | "coder" | "ssh" | "direct";

export interface LivePairingServerOptions {
  sessionId: string;
  mode?: LivePairingMode;
  sshTargetHint?: string;
  directHost?: string;
  environment?: NodeJS.ProcessEnv;
  pairingTtlMs?: number;
  heartbeatMs?: number;
}

type NotificationHandler = (method: string, params: unknown) => void;
type CloseHandler = (error?: Error) => void;

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function websocketUrl(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeDirectHost(host: string, port: number): string {
  const candidate = host.includes("://") ? host : `ws://${host}`;
  const url = new URL(candidate);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  if (url.port.length === 0) url.port = String(port);
  url.pathname = "/live";
  return url.toString();
}

function resolveEndpoints(options: {
  mode: LivePairingMode;
  port: number;
  environment: NodeJS.ProcessEnv;
  sshTargetHint?: string;
  directHost?: string;
}): LivePairingEndpoint[] {
  const endpoints: LivePairingEndpoint[] = [];
  const addLocal = (): void => {
    endpoints.push({ type: "local", url: `ws://127.0.0.1:${options.port}/live` });
  };
  const addSsh = (): void => {
    endpoints.push({
      type: "ssh",
      remoteHost: "127.0.0.1",
      remotePort: options.port,
      ...(options.sshTargetHint !== undefined && options.sshTargetHint.length > 0
        ? { targetHint: options.sshTargetHint }
        : {}),
    });
  };
  const addCoder = (): boolean => {
    const baseUrl = resolveCoderPublicBaseUrl(options.port, options.environment);
    if (baseUrl === null) return false;
    endpoints.push({
      type: "coder",
      url: websocketUrl(baseUrl, "/live"),
      requiresCoderToken: true,
    });
    return true;
  };
  const addDirect = (): boolean => {
    if (options.directHost === undefined || options.directHost.length === 0) return false;
    endpoints.push({ type: "direct", url: normalizeDirectHost(options.directHost, options.port) });
    return true;
  };

  switch (options.mode) {
    case "local":
      addLocal();
      break;
    case "coder":
      if (!addCoder()) throw new Error("Coder pairing requested outside a Coder workspace");
      addSsh();
      break;
    case "ssh":
      addSsh();
      break;
    case "direct":
      if (!addDirect()) throw new Error("Direct pairing requires host=<hostname-or-url>");
      break;
    case "auto":
      if (isRunningInCoderWorkspace(options.environment)) addCoder();
      addSsh();
      addLocal();
      addDirect();
      break;
  }
  return endpoints;
}

export class LiveMediaConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >();
  readonly #notificationHandlers = new Set<NotificationHandler>();
  readonly #closeHandlers = new Set<CloseHandler>();
  #nextRequestId = 1;
  #closed = false;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.#handleMessage(rawDataText(data));
    });
    socket.on("error", (cause) => {
      this.#emitClose(errorFrom(cause));
    });
    socket.on("close", () => {
      this.#emitClose();
    });
  }

  get open(): boolean {
    return !this.#closed && this.#socket.readyState === WebSocket.OPEN;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.#notificationHandlers.add(handler);
    return () => {
      this.#notificationHandlers.delete(handler);
    };
  }

  onClose(handler: CloseHandler): () => void {
    this.#closeHandlers.add(handler);
    return () => {
      this.#closeHandlers.delete(handler);
    };
  }

  notify(method: string, params?: unknown): void {
    this.#send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.open) {
      return this.#requestOpen(method, params, timeoutMs);
    }
    return Promise.reject(new Error("Pi Live app is disconnected"));
  }

  #requestOpen(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = String(this.#nextRequestId++);
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi Live app request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref?.();
      this.#pending.set(id, {
        resolve,
        reject,
        timeout,
      });
    });
    this.#send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return promise;
  }

  close(code = 1000, reason = "done"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close(code, reason);
    this.#rejectPending(new Error("Pi Live app connection closed"));
  }

  #send(value: unknown): void {
    if (!this.open) throw new Error("Pi Live app is disconnected");
    this.#socket.send(JSON.stringify(value));
  }

  #handleMessage(payload: string): void {
    const message = parseJsonRpcMessage(payload);
    if (message === undefined) return;
    if (message.kind === "notification") {
      for (const handler of this.#notificationHandlers)
        handler(message.value.method, message.value.params);
      return;
    }
    if (message.kind !== "response") return;
    const pending = this.#pending.get(String(message.value.id));
    if (pending === undefined) return;
    this.#pending.delete(String(message.value.id));
    clearTimeout(pending.timeout);
    if (message.value.error === undefined) {
      pending.resolve(message.value.result);
    } else {
      pending.reject(new Error(message.value.error.message));
    }
  }

  #emitClose(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(error ?? new Error("Pi Live app disconnected"));
    for (const handler of this.#closeHandlers) handler(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

// eslint-disable-next-line max-classes-per-file -- server and accepted connection share one lifecycle.
export class LivePairingServer {
  readonly #options: LivePairingServerOptions;
  readonly #secret = randomBytes(32).toString("base64url");
  readonly #serverNonce = randomBytes(16).toString("base64url");
  readonly #websocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  #server: Server | undefined;
  #descriptor: PairingDescriptor | undefined;
  #connection: LiveMediaConnection | undefined;
  #acceptPromise: Promise<LiveMediaConnection> | undefined;
  #acceptResolve: ((connection: LiveMediaConnection) => void) | undefined;
  #acceptReject: ((error: Error) => void) | undefined;
  #expiryTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: LivePairingServerOptions) {
    this.#options = options;
  }

  get descriptor(): PairingDescriptor {
    if (this.#descriptor === undefined) throw new Error("Pairing server has not started");
    return this.#descriptor;
  }

  async start(): Promise<PairingDescriptor> {
    if (this.#descriptor !== undefined) return this.#descriptor;
    if (this.#closed) throw new Error("Pairing server is closed");
    const environment = this.#options.environment ?? process.env;
    const mode = this.#options.mode ?? "auto";
    const bindPublicly =
      mode === "coder" ||
      mode === "direct" ||
      (mode === "auto" && isRunningInCoderWorkspace(environment));
    const host = bindPublicly ? "0.0.0.0" : "127.0.0.1";
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && pathname === "/health") {
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ ok: true, protocolVersion: LIVE_PAIRING_PROTOCOL_VERSION }));
        return;
      }
      response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("not found");
    });
    this.#server = server;
    server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname !== "/live" || this.#connection !== undefined) {
        socket.write("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.#websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.#acceptCandidate(websocket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Pairing server did not expose a TCP port");
    }
    const port = address.port;
    const expiresAt = Date.now() + (this.#options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS);
    const payload: PairingPayload = {
      protocolVersion: LIVE_PAIRING_PROTOCOL_VERSION,
      sessionId: this.#options.sessionId,
      serverNonce: this.#serverNonce,
      expiresAt,
      endpoints: resolveEndpoints({
        mode,
        port,
        environment,
        sshTargetHint: this.#options.sshTargetHint,
        directHost: this.#options.directHost,
      }),
    };
    this.#descriptor = { ...payload, uri: encodePairingUri(payload, this.#secret) };
    this.#expiryTimer = setTimeout(
      () => {
        this.#acceptReject?.(new Error("Pi Live pairing URL expired"));
        void this.close();
      },
      Math.max(1, expiresAt - Date.now()),
    );
    this.#expiryTimer.unref?.();
    return this.#descriptor;
  }

  accept(): Promise<LiveMediaConnection> {
    if (this.#connection !== undefined) return Promise.resolve(this.#connection);
    if (this.#acceptPromise !== undefined) return this.#acceptPromise;
    this.#acceptPromise = new Promise<LiveMediaConnection>((resolve, reject) => {
      this.#acceptResolve = resolve;
      this.#acceptReject = reject;
    });
    return this.#acceptPromise;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#expiryTimer !== undefined) clearTimeout(this.#expiryTimer);
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#connection?.close();
    this.#websocketServer.close();
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }

  #acceptCandidate(socket: WebSocket): void {
    const timeout = setTimeout(() => {
      socket.close(1008, "pairing timeout");
    }, 10_000);
    timeout.unref?.();
    const onFirstMessage = (data: RawData, isBinary: boolean): void => {
      clearTimeout(timeout);
      if (isBinary) {
        socket.close(1003, "text frames required");
        return;
      }
      const message = parseJsonRpcMessage(rawDataText(data));
      if (message === undefined || message.kind !== "request" || message.value.method !== "pair") {
        socket.send(jsonRpcError("0", -32600, "First request must be pair"));
        socket.close(1008, "pair first");
        return;
      }
      const params = parsePairRequestParams(message.value.params);
      if (params === undefined) {
        socket.send(jsonRpcError(message.value.id, -32001, "Pairing rejected"));
        socket.close(1008, "pairing rejected");
        return;
      }
      if (params.capabilities.webrtc && this.#secretMatches(params.secret)) {
        this.#completePairing(socket, message.value.id);
        return;
      }
      socket.send(jsonRpcError(message.value.id, -32001, "Pairing rejected"));
      socket.close(1008, "pairing rejected");
    };
    socket.once("message", onFirstMessage);
  }

  #completePairing(socket: WebSocket, requestId: JsonRpcId): void {
    if (
      this.#descriptor === undefined ||
      Date.now() >= this.#descriptor.expiresAt ||
      this.#connection !== undefined
    ) {
      socket.send(jsonRpcError(requestId, -32002, "Pairing expired or already used"));
      socket.close(1008, "pairing unavailable");
      return;
    }
    if (this.#expiryTimer !== undefined) clearTimeout(this.#expiryTimer);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        result: {
          protocolVersion: LIVE_PAIRING_PROTOCOL_VERSION,
          sessionId: this.#options.sessionId,
          serverNonce: this.#serverNonce,
        },
      }),
    );
    const connection = new LiveMediaConnection(socket);
    this.#connection = connection;
    this.#acceptResolve?.(connection);
    this.#startHeartbeat(connection);
  }

  #secretMatches(candidate: string): boolean {
    const expected = Buffer.from(this.#secret, "utf8");
    const actual = Buffer.from(candidate, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  #startHeartbeat(connection: LiveMediaConnection): void {
    const heartbeatMs = this.#options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#heartbeatTimer = setInterval(() => {
      if (connection.open) {
        try {
          connection.notify("ping", { timestamp: Date.now() });
        } catch {}
      }
    }, heartbeatMs);
    this.#heartbeatTimer.unref?.();
  }
}
