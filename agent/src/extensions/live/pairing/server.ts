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
  parseResumeRequestParams,
  type JsonRpcId,
  type LivePairingEndpoint,
  type PairingDescriptor,
  type PairingPayload,
  type PairRequestParams,
} from "./schemas.js";
import type { LiveVoice } from "../voices.js";

const DEFAULT_PAIRING_TTL_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_RECONNECT_GRACE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SDP_BYTES = 256 * 1024;

export type LivePairingMode = "auto" | "local" | "coder" | "ssh" | "direct";

export interface LivePairingServerOptions {
  sessionId: string;
  mode?: LivePairingMode;
  sshTargetHint?: string;
  directHost?: string;
  environment?: NodeJS.ProcessEnv;
  pairingTtlMs?: number;
  heartbeatMs?: number;
  reconnectGraceMs?: number;
}

type NotificationHandler = (method: string, params: unknown) => void;
type RequestHandler = (method: string, params: unknown) => unknown;
type CloseHandler = (error?: Error, clean?: boolean) => void;
type ConnectionStateHandler = (state: "connected" | "reconnecting") => void;

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
  readonly preferredVoice: LiveVoice | undefined;
  readonly customInstructions: string | undefined;
  readonly diagnosticsEnabled: boolean | undefined;
  #socket: WebSocket | undefined;
  readonly #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >();
  readonly #notificationHandlers = new Set<NotificationHandler>();
  readonly #requestHandlers = new Set<RequestHandler>();
  readonly #closeHandlers = new Set<CloseHandler>();
  readonly #stateHandlers = new Set<ConnectionStateHandler>();
  readonly #onTransportClose: (error: Error | undefined, clean: boolean) => void;
  #nextRequestId = 1;
  #transportGeneration = 0;
  #terminated = false;

  constructor(
    socket: WebSocket,
    preferences: PairRequestParams["preferences"] | undefined,
    onTransportClose: (error: Error | undefined, clean: boolean) => void,
  ) {
    this.preferredVoice = preferences?.voice;
    this.customInstructions = preferences?.instructions;
    this.diagnosticsEnabled = preferences?.diagnosticsEnabled;
    this.#onTransportClose = onTransportClose;
    this.#bindSocket(socket);
  }

  get open(): boolean {
    return !this.#terminated && this.#socket?.readyState === WebSocket.OPEN;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.#notificationHandlers.add(handler);
    return () => {
      this.#notificationHandlers.delete(handler);
    };
  }

  onRequest(handler: RequestHandler): () => void {
    this.#requestHandlers.add(handler);
    return () => {
      this.#requestHandlers.delete(handler);
    };
  }

  onClose(handler: CloseHandler): () => void {
    this.#closeHandlers.add(handler);
    return () => {
      this.#closeHandlers.delete(handler);
    };
  }

  onState(handler: ConnectionStateHandler): () => void {
    this.#stateHandlers.add(handler);
    return () => {
      this.#stateHandlers.delete(handler);
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
    if (this.#terminated) return;
    this.#terminated = true;
    this.#transportGeneration += 1;
    this.#socket?.close(code, reason);
    this.#socket = undefined;
    this.#rejectPending(new Error("Pi Live app connection closed"));
  }

  resume(socket: WebSocket): void {
    if (this.#terminated) throw new Error("Pi Live app connection has ended");
    if (this.open) throw new Error("Pi Live app is already connected");
    this.#bindSocket(socket);
    this.#emitState("connected");
  }

  markReconnecting(): void {
    if (!this.#terminated) this.#emitState("reconnecting");
  }

  terminate(error?: Error, clean = false): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#transportGeneration += 1;
    this.#socket = undefined;
    this.#rejectPending(error ?? new Error("Pi Live app disconnected"));
    for (const handler of this.#closeHandlers) handler(error, clean);
  }

  #send(value: unknown): void {
    if (!this.open) throw new Error("Pi Live app is disconnected");
    this.#socket?.send(JSON.stringify(value));
  }

  #bindSocket(socket: WebSocket): void {
    this.#socket = socket;
    const generation = ++this.#transportGeneration;
    let transportError: Error | undefined;
    socket.on("message", (data, isBinary) => {
      if (this.#terminated || generation !== this.#transportGeneration || isBinary) return;
      this.#handleMessage(rawDataText(data));
    });
    socket.on("error", (cause) => {
      transportError = errorFrom(cause);
    });
    socket.on("close", (code) => {
      if (this.#terminated || generation !== this.#transportGeneration) return;
      this.#socket = undefined;
      this.#rejectPending(transportError ?? new Error("Pi Live app disconnected"));
      this.#onTransportClose(transportError, code === 1000);
    });
  }

  #handleMessage(payload: string): void {
    const message = parseJsonRpcMessage(payload);
    if (message === undefined) return;
    if (message.kind === "notification") {
      for (const handler of this.#notificationHandlers)
        handler(message.value.method, message.value.params);
      return;
    }
    if (message.kind === "request") {
      this.#handleRequest(message.value.id, message.value.method, message.value.params);
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

  #handleRequest(id: JsonRpcId, method: string, params: unknown): void {
    const handler = this.#requestHandlers.values().next().value;
    if (handler === undefined) {
      this.#send(JSON.parse(jsonRpcError(id, -32601, `Unsupported request: ${method}`)));
      return;
    }
    void Promise.resolve(handler(method, params)).then(
      (result) => {
        if (this.open) this.#send({ jsonrpc: "2.0", id, result });
      },
      (cause) => {
        if (this.open) this.#send(JSON.parse(jsonRpcError(id, -32000, errorFrom(cause).message)));
      },
    );
  }

  #emitState(state: "connected" | "reconnecting"): void {
    for (const handler of this.#stateHandlers) handler(state);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export { parseThreadIdParams, parseThreadMessageParams } from "./schemas.js";

// eslint-disable-next-line max-classes-per-file -- server and accepted connection share one lifecycle.
export class LivePairingServer {
  readonly #options: LivePairingServerOptions;
  readonly #secret = randomBytes(32).toString("base64url");
  readonly #serverNonce = randomBytes(16).toString("base64url");
  readonly #resumeToken = randomBytes(32).toString("base64url");
  readonly #websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_SDP_BYTES * 2,
  });
  #server: Server | undefined;
  #descriptor: PairingDescriptor | undefined;
  #connection: LiveMediaConnection | undefined;
  #acceptPromise: Promise<LiveMediaConnection> | undefined;
  #acceptResolve: ((connection: LiveMediaConnection) => void) | undefined;
  #acceptReject: ((error: Error) => void) | undefined;
  #expiryTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
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
      if (pathname !== "/live") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
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
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
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
      if (message === undefined || message.kind !== "request") {
        socket.send(jsonRpcError("0", -32600, "First request must be pair or resume"));
        socket.close(1008, "pair first");
        return;
      }
      if (message.value.method === "pair") {
        const params = parsePairRequestParams(message.value.params);
        if (
          params !== undefined &&
          params.capabilities.webrtc &&
          this.#secretMatches(params.secret)
        ) {
          this.#completePairing(socket, message.value.id, params);
          return;
        }
      } else if (message.value.method === "resume") {
        const params = parseResumeRequestParams(message.value.params);
        if (params !== undefined && this.#resumeMatches(params)) {
          this.#resumePairing(socket, message.value.id);
          return;
        }
      } else {
        socket.send(jsonRpcError(message.value.id, -32601, "Unsupported initial request"));
        socket.close(1008, "unsupported request");
        return;
      }
      socket.send(jsonRpcError(message.value.id, -32001, "Pairing rejected"));
      socket.close(1008, "pairing rejected");
    };
    socket.once("message", onFirstMessage);
  }

  #completePairing(socket: WebSocket, requestId: JsonRpcId, params: PairRequestParams): void {
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
          resumeToken: this.#resumeToken,
        },
      }),
    );
    const connection = new LiveMediaConnection(socket, params.preferences, (error, clean) => {
      this.#handleTransportClose(error, clean);
    });
    this.#connection = connection;
    this.#acceptResolve?.(connection);
    this.#startHeartbeat(connection);
  }

  #resumePairing(socket: WebSocket, requestId: JsonRpcId): void {
    const connection = this.#connection;
    if (connection === undefined || connection.open || this.#reconnectTimer === undefined) {
      socket.send(jsonRpcError(requestId, -32003, "Session is not awaiting reconnection"));
      socket.close(1008, "resume unavailable");
      return;
    }
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        result: {
          protocolVersion: LIVE_PAIRING_PROTOCOL_VERSION,
          sessionId: this.#options.sessionId,
          serverNonce: this.#serverNonce,
          resumed: true,
        },
      }),
    );
    connection.resume(socket);
  }

  #secretMatches(candidate: string): boolean {
    const expected = Buffer.from(this.#secret, "utf8");
    const actual = Buffer.from(candidate, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  #resumeMatches(params: { sessionId: string; serverNonce: string; resumeToken: string }): boolean {
    return (
      params.sessionId === this.#options.sessionId &&
      params.serverNonce === this.#serverNonce &&
      this.#constantTimeMatches(this.#resumeToken, params.resumeToken)
    );
  }

  #constantTimeMatches(expectedValue: string, candidateValue: string): boolean {
    const expected = Buffer.from(expectedValue, "utf8");
    const actual = Buffer.from(candidateValue, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  #handleTransportClose(error: Error | undefined, clean: boolean): void {
    const connection = this.#connection;
    if (connection === undefined) return;
    if (clean) {
      connection.terminate(error, true);
      return;
    }
    connection.markReconnecting();
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    const reconnectGraceMs = this.#options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      connection.terminate(error ?? new Error("Pi Live app reconnection timed out"));
    }, reconnectGraceMs);
    this.#reconnectTimer.unref?.();
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
