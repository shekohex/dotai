/**
 * Remote mode: expose a pi agent session over a TCP socket using the same JSON line protocol as `pi
 * --mode rpc` (stdio).
 *
 * Designed for embedding pi in another application that connects over an SSH port-forward. The
 * session is created in-process (no subprocess, no stdio) and driven by the direct session API —
 * the same approach as the subagent SDK LiteRuntime, with control inverted (external TCP controller
 * → session).
 *
 * Lifecycle contract:
 *
 * - Single controller at a time; 2nd rejected with `busy`.
 * - Controller drops mid-turn → turn keeps running, session + port stay alive. Controller rebuilds
 *   state via get_state / get_messages on reconnect.
 * - No event replay buffer; the session is the source of truth.
 * - Idle (not streaming, no pending messages) for > idleTimeoutMs → dispose + exit.
 * - `{type:"shutdown"}` command stops the process cleanly.
 */

import * as net from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

import { getAgentDir, type AgentSession } from "@earendil-works/pi-coding-agent";

import { errorMessage } from "../utils/error-message.js";
import {
  createCommandHandler,
  type CommandHandlerContext,
  type CommandResponse,
  type RemoteCommand,
} from "./commands.js";
import { createRemoteSession, type RemoteSessionHandle } from "./session.js";

// ============================================================================
// Constants
// ============================================================================

const KEEPALIVE_INITIAL_DELAY_MS = 15_000;
const IDLE_POLL_INTERVAL_MS = 5_000;
const AUTH_LINE_TIMEOUT_MS = 10_000;
const AUTH_LINE_MAX_BYTES = 65536;

// ============================================================================
// CLI argument parsing
// ============================================================================

export interface RemoteModeArgs {
  host: string;
  port: number;
  token: string;
  idleTimeoutMs: number;
  cwd: string;
}

export function isRemoteMode(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode" && i + 1 < args.length) {
      return args[i + 1] === "remote";
    }
    if (args[i].startsWith("--mode=remote")) {
      return true;
    }
  }
  return false;
}

export function parseRemoteModeArgs(args: string[]): RemoteModeArgs {
  let host = "127.0.0.1";
  let port = 0;
  let token = "";
  let idleTimeoutSeconds = 300;
  let cwd = process.cwd();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i];
    if (arg === "--host") host = next();
    else if (arg === "--port") port = Number.parseInt(next(), 10) || 0;
    else if (arg === "--token") token = next();
    else if (arg === "--remote-idle-timeout") idleTimeoutSeconds = Number.parseInt(next(), 10) || 0;
    else if (arg === "--cwd") cwd = next();
  }

  return { host, port, token, idleTimeoutMs: idleTimeoutSeconds * 1000, cwd };
}

// ============================================================================
// JSONL framing (LF-only, mirrors pi rpc)
// ============================================================================

function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function attachJsonlReader(
  stream: Readable,
  onLine: (line: string) => void,
  initialChunk?: Buffer,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emitLine = (line: string): void => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  const onData = (chunk: string | Buffer): void => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  };

  const onEnd = (): void => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = "";
    }
  };

  if (initialChunk && initialChunk.length > 0) {
    onData(initialChunk);
  }

  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

function safeWrite(socket: net.Socket, text: string): void {
  try {
    if (!socket.destroyed && socket.writable) socket.write(text);
  } catch {
    // 'close' handles teardown
  }
}

function parseRpcCommand(value: unknown): RemoteCommand | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("type" in value) || typeof value.type !== "string") return undefined;
  if ("id" in value && value.id !== undefined && typeof value.id !== "string") return undefined;
  const id = "id" in value && typeof value.id === "string" ? value.id : undefined;
  return buildRpcCommand(value, value.type, id);
}

function buildRpcCommand(
  value: object,
  type: string,
  id: string | undefined,
): RemoteCommand | undefined {
  switch (type) {
    case "prompt":
      if ("message" in value && typeof value.message === "string") {
        return { ...value, type: "prompt", id, message: value.message };
      }
      return undefined;
    case "steer":
      if ("message" in value && typeof value.message === "string") {
        return { ...value, type: "steer", id, message: value.message };
      }
      return undefined;
    case "follow_up":
      if ("message" in value && typeof value.message === "string") {
        return { ...value, type: "follow_up", id, message: value.message };
      }
      return undefined;
    case "set_model":
      if (
        "provider" in value &&
        typeof value.provider === "string" &&
        "modelId" in value &&
        typeof value.modelId === "string"
      ) {
        return {
          ...value,
          type: "set_model",
          id,
          provider: value.provider,
          modelId: value.modelId,
        };
      }
      return undefined;
    case "set_thinking_level":
      if (
        "level" in value &&
        (value.level === "off" ||
          value.level === "minimal" ||
          value.level === "low" ||
          value.level === "medium" ||
          value.level === "high" ||
          value.level === "xhigh")
      ) {
        return { ...value, type: "set_thinking_level", id, level: value.level };
      }
      return undefined;
    case "set_steering_mode":
      if ("mode" in value && (value.mode === "all" || value.mode === "one-at-a-time")) {
        return { ...value, type: "set_steering_mode", id, mode: value.mode };
      }
      return undefined;
    case "set_follow_up_mode":
      if ("mode" in value && (value.mode === "all" || value.mode === "one-at-a-time")) {
        return { ...value, type: "set_follow_up_mode", id, mode: value.mode };
      }
      return undefined;
    case "set_auto_compaction":
      if ("enabled" in value && typeof value.enabled === "boolean") {
        return { ...value, type: "set_auto_compaction", id, enabled: value.enabled };
      }
      return undefined;
    case "set_auto_retry":
      if ("enabled" in value && typeof value.enabled === "boolean") {
        return { ...value, type: "set_auto_retry", id, enabled: value.enabled };
      }
      return undefined;
    case "bash":
      if ("command" in value && typeof value.command === "string") {
        return { ...value, type: "bash", id, command: value.command };
      }
      return undefined;
    case "switch_session":
      if ("sessionPath" in value && typeof value.sessionPath === "string") {
        return { ...value, type: "switch_session", id, sessionPath: value.sessionPath };
      }
      return undefined;
    case "fork":
      if ("entryId" in value && typeof value.entryId === "string") {
        return { ...value, type: "fork", id, entryId: value.entryId };
      }
      return undefined;
    case "set_session_name":
      if ("name" in value && typeof value.name === "string") {
        return { ...value, type: "set_session_name", id, name: value.name };
      }
      return undefined;
    case "abort":
    case "new_session":
    case "get_state":
    case "cycle_model":
    case "get_available_models":
    case "cycle_thinking_level":
    case "compact":
    case "abort_retry":
    case "abort_bash":
    case "get_session_stats":
    case "export_html":
    case "clone":
    case "get_fork_messages":
    case "get_last_assistant_text":
    case "get_messages":
    case "get_commands":
      return { ...value, type, id };
    case "shutdown":
      return { ...value, type: "shutdown", id };
    default:
      return undefined;
  }
}

// ============================================================================
// Controller connection
// ============================================================================

interface ControllerConnection {
  socket: net.Socket;
  write: (obj: unknown) => void;
  detachInput: () => void;
  detachSession: (() => void) | undefined;
}

// ============================================================================
// Remote mode
// ============================================================================

interface RemoteServerState {
  activeConn: ControllerConnection | undefined;
  shuttingDown: boolean;
}

export async function runRemoteMode(args: RemoteModeArgs): Promise<never> {
  const agentDir = getAgentDir();
  const handle = await createRemoteSession({ cwd: args.cwd, agentDir });

  const state: RemoteServerState = { activeConn: undefined, shuttingDown: false };
  const signalCleanup: Array<() => void> = [];
  const idleWatcher = createIdleWatcher(handle.session, args.idleTimeoutMs, () => {
    shutdown(0);
  });

  function shutdown(exitCode = 0): never {
    if (state.shuttingDown) process.exit(exitCode);
    state.shuttingDown = true;
    idleWatcher.stop();
    for (const cleanup of signalCleanup) cleanup();
    const conn = state.activeConn;
    state.activeConn = undefined;
    conn?.detachInput();
    conn?.detachSession?.();
    try {
      conn?.socket.destroy();
    } catch {
      // ignore
    }
    try {
      server.close();
    } catch {
      // ignore
    }
    handle.dispose();
    process.exit(exitCode);
  }

  const onControllerGone = (conn: ControllerConnection): void => {
    if (state.activeConn !== conn) return;
    state.activeConn = undefined;
    conn.detachSession?.();
    // Session keeps running (locked decision); reconnect reattaches.
  };

  const cmdCtx: CommandHandlerContext = {
    session: handle.session,
    getActiveConn: () => state.activeConn,
    requestShutdown: () => {
      shutdown(0);
    },
  };
  const handleCommand = createCommandHandler(cmdCtx);

  registerSignalHandlers(signalCleanup, (signal) => {
    shutdown(signal);
  });

  const server = net.createServer(
    { keepAlive: true, keepAliveInitialDelay: KEEPALIVE_INITIAL_DELAY_MS },
    (socket) => {
      handleConnection(socket, args, state, handle, handleCommand, onControllerGone);
    },
  );
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(`Remote mode server error: ${error.message}`);
    shutdown(1);
  });

  idleWatcher.start();
  server.listen(args.port, args.host, () => {
    const address = server.address();
    const boundHost = address !== null && typeof address === "object" ? address.address : args.host;
    const boundPort = address !== null && typeof address === "object" ? address.port : args.port;
    process.stdout.write(
      serializeJsonLine({ type: "ready", host: boundHost, port: boundPort, pid: process.pid }),
    );
  });

  return new Promise(() => {});
}

function registerSignalHandlers(
  cleanup: Array<() => void>,
  shutdown: (exitCode: number) => void,
): void {
  const signals: Array<{ name: NodeJS.Signals; code: number }> = [
    { name: "SIGTERM", code: 143 },
    { name: "SIGINT", code: 130 },
  ];
  if (process.platform !== "win32") signals.push({ name: "SIGHUP", code: 129 });
  for (const { name, code } of signals) {
    const handler = (): void => {
      shutdown(code);
    };
    process.on(name, handler);
    cleanup.push(() => {
      process.off(name, handler);
    });
  }
}

// ============================================================================
// Idle watcher
// ============================================================================

interface IdleWatcher {
  start(): void;
  stop(): void;
}

function createIdleWatcher(
  session: AgentSession,
  timeoutMs: number,
  onIdleTimeout: () => void,
): IdleWatcher {
  let idleSince: number | undefined;
  let timer: NodeJS.Timeout | undefined;

  const check = (): void => {
    const idle = !session.isStreaming && session.pendingMessageCount === 0;
    if (!idle) {
      idleSince = undefined;
      return;
    }
    if (idleSince === undefined) {
      idleSince = Date.now();
      return;
    }
    if (Date.now() - idleSince >= timeoutMs) onIdleTimeout();
  };

  return {
    start(): void {
      if (timeoutMs > 0 && timer === undefined) {
        timer = setInterval(check, IDLE_POLL_INTERVAL_MS);
        timer.unref?.();
      }
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

// ============================================================================
// Connection handler
// ============================================================================

interface ControllerGoneCallback {
  (conn: ControllerConnection): void;
}

function handleConnection(
  socket: net.Socket,
  args: RemoteModeArgs,
  state: RemoteServerState,
  handle: RemoteSessionHandle,
  handleCommand: (command: RemoteCommand) => Promise<CommandResponse | null>,
  onControllerGone: ControllerGoneCallback,
): void {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MS);
  socket.setTimeout(0);
  socket.on("error", () => {
    // 'close' follows
  });

  let conn: ControllerConnection | undefined;
  let authed = false;
  let authTimer: NodeJS.Timeout | undefined = setTimeout(() => {
    if (!authed) {
      safeWrite(socket, serializeJsonLine({ id: null, ok: false, error: "auth timeout" }));
      socket.destroy();
    }
  }, AUTH_LINE_TIMEOUT_MS);

  socket.on("close", () => {
    if (authTimer !== undefined) clearTimeout(authTimer);
    if (conn !== undefined) onControllerGone(conn);
  });

  // Single-controller guard
  if (state.activeConn !== undefined && !state.activeConn.socket.destroyed) {
    safeWrite(
      socket,
      serializeJsonLine({ id: null, ok: false, error: "busy: a controller is already connected" }),
    );
    socket.end();
    return;
  }

  let authBuffer = Buffer.alloc(0);

  const onAuthData = (chunk: Buffer): void => {
    const newlineIndex = chunk.indexOf(0x0a);
    if (newlineIndex === -1) {
      authBuffer = Buffer.concat([authBuffer, chunk]);
      if (authBuffer.length > AUTH_LINE_MAX_BYTES) {
        socket.off("data", onAuthData);
        safeWrite(socket, serializeJsonLine({ id: null, ok: false, error: "auth line too long" }));
        socket.destroy();
      }
      return;
    }

    const lineBuffer = Buffer.concat([authBuffer, chunk.subarray(0, newlineIndex)]);
    const rest = chunk.subarray(newlineIndex + 1);
    socket.off("data", onAuthData);

    const auth = parseAuthLine(lineBuffer.toString("utf8"), args.token);
    if (auth === undefined) {
      if (authTimer !== undefined) clearTimeout(authTimer);
      safeWrite(socket, serializeJsonLine({ id: null, ok: false, error: "unauthorized" }));
      socket.destroy();
      return;
    }

    authed = true;
    if (authTimer !== undefined) clearTimeout(authTimer);
    authTimer = undefined;
    safeWrite(socket, serializeJsonLine({ id: auth.responseId, ok: true }));

    const write = (obj: unknown): void => {
      safeWrite(socket, serializeJsonLine(obj));
    };
    const detachSession = handle.session.subscribe((event) => {
      write(event);
    });

    conn = { socket, write, detachInput: () => {}, detachSession };
    state.activeConn = conn;

    const detachInput = attachJsonlReader(
      socket,
      (line) => {
        void handleCommandLine(line, write, handleCommand);
      },
      rest.length > 0 ? rest : undefined,
    );
    conn.detachInput = detachInput;
  };

  socket.on("data", onAuthData);
}

interface AuthResult {
  responseId: unknown;
}

function parseAuthLine(line: string, expectedToken: string): AuthResult | undefined {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof request !== "object" || request === null) return undefined;
  if (!("method" in request) || request.method !== "auth") return undefined;
  if (!("params" in request) || typeof request.params !== "object" || request.params === null) {
    return undefined;
  }
  if (!("token" in request.params) || request.params.token !== expectedToken) return undefined;
  const responseId = "id" in request ? request.id : null;
  return { responseId };
}

async function handleCommandLine(
  line: string,
  write: (obj: unknown) => void,
  handleCommand: (command: RemoteCommand) => Promise<CommandResponse | null>,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    write({
      id: undefined,
      type: "response",
      command: "parse",
      success: false,
      error: errorMessage(e),
    });
    return;
  }
  const command = parseRpcCommand(parsed);
  if (command === undefined) {
    write({
      id: undefined,
      type: "response",
      command: "unknown",
      success: false,
      error: "invalid command",
    });
    return;
  }
  try {
    const response = await handleCommand(command);
    if (response !== null) write(response);
  } catch (e) {
    write({
      id: command.id,
      type: "response",
      command: command.type,
      success: false,
      error: errorMessage(e),
    });
  }
}
