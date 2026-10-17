import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  expandEnv,
  fillPath,
  isSocketUrl,
  MAX_ARGS_BYTES,
  parseFrame,
  parseOutput,
  preview,
  type SourceFailure,
  SourceError,
  type SourceSpec,
  STREAM_DONE,
} from "../shared/sources";

const OUTPUT_LIMIT = 1_000_000;
const STDERR_LIMIT = 4_000;
const KILL_GRACE_MS = 1_500;
const BAD_LINES_BEFORE_FAILING = 20;

export interface RunContext {
  /** The agent's working directory: where a command runs unless the source names its own. */
  cwd: string;
  name: string;
}

export interface Sink {
  frame(value: unknown): void;
  /** Called once when the stream is over; a failure means it did not end cleanly. */
  end(failure?: SourceFailure): void;
}

export interface Channel {
  stop(): void;
}

function argsJson(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  if (Buffer.byteLength(json) > MAX_ARGS_BYTES) {
    throw new SourceError("bad-args", `The arguments are larger than ${MAX_ARGS_BYTES / 1000} KB. Pass less data to the source.`);
  }
  return json;
}

/** Keeps the tail of a text stream, which is where a program says why it died. */
function tail(limit: number) {
  let text = "";
  return {
    add(chunk: string) {
      text = (text + chunk).slice(-limit);
    },
    get text() {
      return text.trim();
    },
  };
}

/** Cuts a byte stream into lines, holding back the unfinished one. */
function lineSplitter(onLine: (line: string) => void, limit: number, onTooLong: () => void) {
  let pending = "";
  return (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      onLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (pending.length > limit) {
      pending = "";
      onTooLong();
    }
  };
}

/** An AbortController that remembers why it was aborted. */
class Cancel {
  readonly controller = new AbortController();
  reason: SourceError | undefined;
  /** Closes whatever the request opened besides the fetch itself, such as a socket. */
  onAbort: (() => void) | undefined;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(reason?: SourceError): void {
    this.reason ??= reason;
    this.controller.abort();
    this.onAbort?.();
  }
}

export class SourceRunner {
  private readonly children = new Set<ChildProcess>();
  private readonly controllers = new Set<Cancel>();

  constructor(private readonly maxProcesses = 16) {}

  get active(): number {
    return this.children.size + this.controllers.size;
  }

  /** Stops every process and request still running; used when the plugin shuts down. */
  close(): void {
    for (const child of this.children) this.kill(child, "SIGKILL");
    for (const cancel of this.controllers) cancel.abort(new SourceError("stopped", "The source was stopped because the plugin shut down."));
  }

  private kill(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  /** Ends a process politely, then for good if it ignores that. */
  private terminate(child: ChildProcess): void {
    this.kill(child, "SIGTERM");
    setTimeout(() => this.kill(child, "SIGKILL"), KILL_GRACE_MS).unref();
  }

  private async workingDirectory(spec: SourceSpec, context: RunContext): Promise<string> {
    const cwd = spec.cwd ? path.resolve(context.cwd, spec.cwd) : context.cwd;
    const info = await stat(cwd).catch(() => undefined);
    if (!info?.isDirectory()) throw new SourceError("spawn", `The working directory does not exist: ${cwd}`);
    return cwd;
  }

  private launch(spec: SourceSpec, args: Record<string, unknown>, context: RunContext, cwd: string): ChildProcess {
    if (this.active >= this.maxProcesses) {
      throw new SourceError("busy", `Too many sources are running at once (${this.maxProcesses}). Try again in a moment.`);
    }
    const json = argsJson(args);
    const child = spawn("/bin/sh", ["-c", spec.run ?? ""], {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OPENUI_SOURCE: context.name, OPENUI_ARGS: json },
    });
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(`${JSON.stringify({ args })}\n`);
    return child;
  }

  /** Runs the source once and returns the JSON it produced. */
  async once(spec: SourceSpec, args: Record<string, unknown>, context: RunContext): Promise<unknown> {
    if (spec.type === "command") return this.commandOnce(spec, args, context);
    return isSocketUrl(spec.url) ? this.socketOnce(spec, args) : this.httpOnce(spec, args);
  }

  /** Starts a source that keeps producing frames. The sink hears every frame and, once, the end. */
  async stream(spec: SourceSpec, args: Record<string, unknown>, context: RunContext, sink: Sink): Promise<Channel> {
    if (spec.type === "command") return this.commandStream(spec, args, context, sink);
    return isSocketUrl(spec.url) ? this.socketStream(spec, args, sink) : this.httpStream(spec, args, sink);
  }

  private async commandOnce(spec: SourceSpec, args: Record<string, unknown>, context: RunContext): Promise<unknown> {
    const cwd = await this.workingDirectory(spec, context);
    const child = this.launch(spec, args, context, cwd);
    return new Promise<unknown>((resolve, reject) => {
      let out = "";
      let size = 0;
      let overflow = false;
      let timedOut = false;
      const errors = tail(STDERR_LIMIT);
      const timer = setTimeout(() => {
        timedOut = true;
        this.terminate(child);
      }, spec.timeoutSeconds * 1000);
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > OUTPUT_LIMIT) {
          if (!overflow) this.terminate(child);
          overflow = true;
          return;
        }
        out += chunk;
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => errors.add(chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new SourceError("spawn", `Could not start the command: ${error.message}`));
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new SourceError("timeout", `The command did not finish within ${spec.timeoutSeconds}s and was stopped. Make it faster, or raise timeoutSeconds when you define the source.`, errors.text ? `stderr: ${preview(errors.text)}` : undefined));
        } else if (overflow) {
          reject(new SourceError("output", `The command printed more than ${OUTPUT_LIMIT / 1_000_000} MB. Print only what the UI shows.`));
        } else if (code !== 0) {
          reject(new SourceError("exit", `The command failed (${code === null ? `killed by ${signal}` : `exit code ${code}`}).`, errors.text ? `stderr: ${preview(errors.text)}` : undefined));
        } else {
          try {
            resolve(parseOutput(out));
          } catch (error) {
            reject(error instanceof SourceError && errors.text && error.kind === "parse" ? new SourceError(error.kind, error.message, `${error.detail ?? ""}; stderr: ${preview(errors.text)}`) : error);
          }
        }
      });
    });
  }

  private async commandStream(spec: SourceSpec, args: Record<string, unknown>, context: RunContext, sink: Sink): Promise<Channel> {
    const cwd = await this.workingDirectory(spec, context);
    const child = this.launch(spec, args, context, cwd);
    let finished = false;
    let stopped = false;
    let idle: NodeJS.Timeout | undefined;
    let timedOut = false;
    const errors = tail(STDERR_LIMIT);
    const feed = frameFeed(sink, (failure) => finish(failure));
    const finish = (failure?: SourceFailure) => {
      if (finished) return;
      finished = true;
      if (idle) clearTimeout(idle);
      sink.end(stopped ? undefined : failure);
      if (failure || stopped) this.terminate(child);
    };
    const watch = () => {
      if (idle) clearTimeout(idle);
      if (spec.timeoutSeconds > 0 && !finished) {
        idle = setTimeout(() => {
          timedOut = true;
          finish({ kind: "timeout", message: `The stream printed nothing for ${spec.timeoutSeconds}s and was stopped. Raise timeoutSeconds (0 turns the idle timeout off) if it is quiet on purpose.`, ...(errors.text ? { detail: `stderr: ${preview(errors.text)}` } : {}) });
        }, spec.timeoutSeconds * 1000);
      }
    };
    watch();
    const split = lineSplitter((line) => feed.line(line), OUTPUT_LIMIT, () => feed.tooLong());
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      watch();
      split(chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => errors.add(chunk));
    child.once("error", (error) => finish({ kind: "spawn", message: `Could not start the command: ${error.message}` }));
    child.once("close", (code, signal) => {
      if (finished || timedOut) return;
      const quiet = feed.empty();
      if (code === 0 || stopped) finish(quiet);
      else finish({ kind: "exit", message: `The command stopped (${code === null ? `killed by ${signal}` : `exit code ${code}`}).`, ...(errors.text ? { detail: `stderr: ${preview(errors.text)}` } : {}) });
    });
    return {
      stop: () => {
        stopped = true;
        finish();
      },
    };
  }

  /** The url with its path arguments, fixed query and, for GET, the remaining arguments filled in; and the body for the rest. */
  private target(spec: SourceSpec, args: Record<string, unknown>, get: boolean): { url: URL; body: Record<string, unknown> } {
    argsJson(args);
    const filled = fillPath(expandEnv(spec.url ?? "", process.env), args);
    let url: URL;
    try {
      url = new URL(filled.url);
    } catch (error) {
      throw new SourceError("invalid-source", `The url is not valid: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, expandEnv(String(value), process.env));
    if (get) {
      for (const [key, value] of Object.entries(filled.rest)) url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
      return { url, body: {} };
    }
    return { url, body: { ...(spec.body ?? {}), ...filled.rest } };
  }

  private requestInit(spec: SourceSpec, args: Record<string, unknown>, signal: AbortSignal, accept: string): { url: string; init: RequestInit } {
    const method = spec.method ?? "GET";
    const headers: Record<string, string> = { accept };
    for (const [name, value] of Object.entries(spec.headers ?? {})) headers[name] = expandEnv(value, process.env);
    const { url, body } = this.target(spec, args, method === "GET");
    if (method === "GET") return { url: url.toString(), init: { method, headers, signal } };
    headers["content-type"] ??= "application/json";
    return { url: url.toString(), init: { method, headers, signal, body: JSON.stringify(body) } };
  }

  private async fetchFrom(spec: SourceSpec, args: Record<string, unknown>, cancel: Cancel, accept: string): Promise<Response> {
    const target = this.requestInit(spec, args, cancel.signal, accept);
    let response: Response;
    try {
      response = await fetch(target.url, target.init);
    } catch (error) {
      if (cancel.signal.aborted) throw cancel.reason ?? new SourceError("stopped", "The request was stopped.");
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      throw new SourceError("network", `Could not reach ${new URL(target.url).host}: ${cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error))}`);
    }
    if (!response.ok) {
      const body = await response.text().then((text) => text.slice(0, 600), () => "");
      cancel.abort();
      throw new SourceError("http", `${new URL(target.url).host} answered HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`, body ? `body: ${preview(body)}` : undefined);
    }
    return response;
  }

  /** Opens the WebSocket for a source and sends the opening message: the fixed body with the arguments over it, when either exists. */
  private openSocket(spec: SourceSpec, args: Record<string, unknown>): WebSocket {
    const Socket = (globalThis as { WebSocket?: new (url: string, options?: unknown) => WebSocket }).WebSocket;
    if (!Socket) throw new SourceError("invalid-source", "This Node.js has no WebSocket support. Update to Node 22 or newer, or use an http source.");
    const { url, body } = this.target(spec, args, false);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(spec.headers ?? {})) headers[name] = expandEnv(value, process.env);
    const socket = new Socket(url.toString(), { headers });
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (Object.keys(body).length > 0) socket.send(JSON.stringify(body));
    });
    return socket;
  }

  private socketOnce(spec: SourceSpec, args: Record<string, unknown>): Promise<unknown> {
    if (this.active >= this.maxProcesses) throw new SourceError("busy", `Too many sources are running at once (${this.maxProcesses}). Try again in a moment.`);
    const cancel = new Cancel();
    this.controllers.add(cancel);
    return new Promise<unknown>((resolve, reject) => {
      let socket: WebSocket;
      let settled = false;
      const settle = (done: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.controllers.delete(cancel);
        try {
          socket?.close();
        } catch {
          // already closed
        }
        done();
      };
      const timer = setTimeout(() => settle(() => reject(new SourceError("timeout", `The WebSocket sent no message within ${spec.timeoutSeconds}s and was closed. Raise timeoutSeconds when you define the source.`))), spec.timeoutSeconds * 1000);
      cancel.onAbort = () => settle(() => reject(cancel.reason ?? new SourceError("stopped", "The socket was stopped.")));
      try {
        socket = this.openSocket(spec, args);
      } catch (error) {
        return settle(() => reject(error));
      }
      const host = new URL(spec.url ?? "ws://x").host;
      socket.addEventListener("message", (event) => {
        try {
          for (const line of messageText(event.data).split(/\r?\n/)) {
            const value = parseFrame(line);
            if (value === undefined) continue;
            if (value === STREAM_DONE) break;
            return settle(() => resolve(value));
          }
        } catch (error) {
          return settle(() => reject(error));
        }
      });
      socket.addEventListener("error", (event) => settle(() => reject(new SourceError("network", `Could not talk to ${host}: ${(event as { message?: string }).message || "connection failed"}`))));
      socket.addEventListener("close", (event) => settle(() => reject(new SourceError("network", `${host} closed the WebSocket before sending a JSON message (code ${event.code}${event.reason ? `, ${event.reason}` : ""}).`))));
    });
  }

  private async socketStream(spec: SourceSpec, args: Record<string, unknown>, sink: Sink): Promise<Channel> {
    if (this.active >= this.maxProcesses) throw new SourceError("busy", `Too many sources are running at once (${this.maxProcesses}). Try again in a moment.`);
    const cancel = new Cancel();
    this.controllers.add(cancel);
    let finished = false;
    let idle: NodeJS.Timeout | undefined;
    let socket: WebSocket;
    const finish = (failure?: SourceFailure) => {
      if (finished) return;
      finished = true;
      if (idle) clearTimeout(idle);
      this.controllers.delete(cancel);
      try {
        socket?.close();
      } catch {
        // already closed
      }
      sink.end(failure);
    };
    cancel.onAbort = () => finish({ kind: "stopped", message: "The socket was stopped because the plugin shut down." });
    try {
      socket = this.openSocket(spec, args);
    } catch (error) {
      this.controllers.delete(cancel);
      throw error;
    }
    const host = new URL(spec.url ?? "ws://x").host;
    const watch = () => {
      if (idle) clearTimeout(idle);
      if (spec.timeoutSeconds > 0 && !finished) {
        idle = setTimeout(() => finish({ kind: "timeout", message: `The WebSocket sent nothing for ${spec.timeoutSeconds}s and was closed. Raise timeoutSeconds (0 turns the idle timeout off) if it is quiet on purpose.` }), spec.timeoutSeconds * 1000);
      }
    };
    watch();
    const feed = frameFeed(sink, (failure) => finish(failure));
    socket.addEventListener("message", (event) => {
      watch();
      for (const line of messageText(event.data).split(/\r?\n/)) feed.line(line);
    });
    socket.addEventListener("error", (event) => finish({ kind: "network", message: `Could not talk to ${host}: ${(event as { message?: string }).message || "connection failed"}` }));
    socket.addEventListener("close", (event) => {
      if (event.code === 1000 || event.code === 1005) finish(feed.empty());
      else finish({ kind: "network", message: `${host} closed the WebSocket (code ${event.code}${event.reason ? `, ${event.reason}` : ""}).` });
    });
    return { stop: () => finish() };
  }

  private async httpOnce(spec: SourceSpec, args: Record<string, unknown>): Promise<unknown> {
    if (this.active >= this.maxProcesses) throw new SourceError("busy", `Too many sources are running at once (${this.maxProcesses}). Try again in a moment.`);
    const cancel = new Cancel();
    this.controllers.add(cancel);
    const timer = setTimeout(() => cancel.abort(new SourceError("timeout", `The request did not finish within ${spec.timeoutSeconds}s and was stopped. Raise timeoutSeconds when you define the source.`)), spec.timeoutSeconds * 1000);
    try {
      const response = await this.fetchFrom(spec, args, cancel, "application/json");
      const text = await readCapped(response, cancel);
      return parseOutput(text);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      if (cancel.signal.aborted && cancel.reason) throw cancel.reason;
      throw new SourceError("network", `The response could not be read: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(cancel);
    }
  }

  private async httpStream(spec: SourceSpec, args: Record<string, unknown>, sink: Sink): Promise<Channel> {
    if (this.active >= this.maxProcesses) throw new SourceError("busy", `Too many sources are running at once (${this.maxProcesses}). Try again in a moment.`);
    const cancel = new Cancel();
    this.controllers.add(cancel);
    let finished = false;
    let idle: NodeJS.Timeout | undefined;
    const finish = (failure?: SourceFailure) => {
      if (finished) return;
      finished = true;
      if (idle) clearTimeout(idle);
      this.controllers.delete(cancel);
      cancel.abort();
      sink.end(failure);
    };
    const watch = () => {
      if (idle) clearTimeout(idle);
      if (spec.timeoutSeconds > 0 && !finished) {
        idle = setTimeout(() => finish({ kind: "timeout", message: `The stream sent nothing for ${spec.timeoutSeconds}s and was stopped. Raise timeoutSeconds (0 turns the idle timeout off) if it is quiet on purpose.` }), spec.timeoutSeconds * 1000);
      }
    };
    watch();
    let response: Response;
    try {
      response = await this.fetchFrom(spec, args, cancel, "text/event-stream, application/x-ndjson, application/json");
    } catch (error) {
      finished = true;
      if (idle) clearTimeout(idle);
      this.controllers.delete(cancel);
      throw error;
    }
    const feed = frameFeed(sink, (failure) => finish(failure));
    const split = lineSplitter((line) => feed.line(line), OUTPUT_LIMIT, () => feed.tooLong());
    void (async () => {
      try {
        const reader = response.body?.getReader();
        if (!reader) return finish({ kind: "http", message: "The server sent no body to stream." });
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          watch();
          split(decoder.decode(value, { stream: true }));
        }
        split("\n");
        finish(feed.empty());
      } catch (error) {
        if (!finished) finish({ kind: "network", message: `The stream broke: ${error instanceof Error ? error.message : String(error)}` });
      }
    })();
    return { stop: () => finish() };
  }
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return String(data);
}

/** Reads a response body up to the output limit. */
async function readCapped(response: Response, cancel: Cancel): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > OUTPUT_LIMIT) {
      cancel.abort();
      throw new SourceError("output", `The response is larger than ${OUTPUT_LIMIT / 1_000_000} MB. Return only what the UI shows.`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Turns the lines of a stream into frames for a sink. A line that is not JSON is skipped, since
 * programs print banners; many in a row, or nothing but such lines, is a failure.
 */
function frameFeed(sink: Sink, fail: (failure: SourceFailure) => void) {
  let frames = 0;
  let bad = 0;
  let firstBad: string | undefined;
  let done = false;
  return {
    line(line: string) {
      if (done) return;
      try {
        const value = parseFrame(line);
        if (value === undefined) return;
        if (value === STREAM_DONE) {
          done = true;
          return;
        }
        bad = 0;
        frames++;
        sink.frame(value);
      } catch (error) {
        if (!(error instanceof SourceError)) throw error;
        if (error.kind === "rpc") return fail(error.toFailure());
        bad++;
        firstBad ??= error.detail;
        if (bad >= BAD_LINES_BEFORE_FAILING) fail({ kind: "parse", message: `${bad} lines in a row were not JSON. A stream prints one JSON value per line.`, ...(firstBad ? { detail: firstBad } : {}) });
      }
    },
    tooLong() {
      fail({ kind: "output", message: `A line of the stream is longer than ${OUTPUT_LIMIT / 1_000_000} MB. Print one compact JSON value per line.` });
    },
    /** A failure to report when the stream ended without a single frame because of unreadable lines. */
    empty(): SourceFailure | undefined {
      return frames === 0 && firstBad !== undefined ? { kind: "parse", message: "The stream ended without printing any JSON. It must print one JSON value per line.", detail: firstBad } : undefined;
    },
  };
}

// ── Shared streams ──────────────────────────────────────────────────────────

export type StreamState = "running" | "ended" | "failed";

export interface StreamRead {
  cursor: number;
  state: StreamState | "gone";
  changed: boolean;
  data: unknown;
  error?: SourceFailure;
}

interface Live {
  id: string;
  key: string;
  agentId: string;
  frames: unknown[];
  window: number;
  seq: number;
  state: StreamState;
  error?: SourceFailure;
  holders: number;
  lastSeen: number;
  endedAt?: number;
  channel?: Channel;
  wake: Set<() => void>;
}

export interface StreamLimits {
  perAgent: number;
  total: number;
  /** A stream nobody has read from for this long is stopped. */
  abandonedMs: number;
}

const DEFAULT_LIMITS: StreamLimits = { perAgent: 8, total: 32, abandonedMs: 45_000 };

/** Keeps each stream's latest value for the app to long-poll, shared by every card that opens the same source and args. */
export class StreamHub {
  private readonly streams = new Map<string, Live>();
  private readonly byKey = new Map<string, Live>();
  private readonly reaper: NodeJS.Timeout;

  constructor(
    private readonly runner: SourceRunner,
    private readonly limits: StreamLimits = DEFAULT_LIMITS,
    reapEveryMs = 5_000,
  ) {
    this.reaper = setInterval(() => this.reap(), reapEveryMs);
    this.reaper.unref();
  }

  get size(): number {
    return this.streams.size;
  }

  private reap(): void {
    const now = Date.now();
    for (const live of this.streams.values()) {
      if (live.state === "running" && now - live.lastSeen > this.limits.abandonedMs) this.drop(live);
      else if (live.state !== "running" && now - (live.endedAt ?? now) > this.limits.abandonedMs) this.drop(live);
    }
  }

  private drop(live: Live): void {
    live.channel?.stop();
    this.streams.delete(live.id);
    if (this.byKey.get(live.key) === live) this.byKey.delete(live.key);
    for (const wake of live.wake) wake();
  }

  /** Joins the running stream for this source and args, or starts one. */
  async open(agentId: string, spec: SourceSpec, args: Record<string, unknown>, context: RunContext): Promise<{ id: string; seq: number }> {
    const key = `${agentId}\0${context.name}\0${JSON.stringify(args)}`;
    const existing = this.byKey.get(key);
    if (existing && existing.state === "running") {
      existing.holders++;
      existing.lastSeen = Date.now();
      return { id: existing.id, seq: existing.seq };
    }
    if (existing) this.drop(existing);
    const mine = [...this.streams.values()].filter((live) => live.agentId === agentId && live.state === "running").length;
    if (mine >= this.limits.perAgent) throw new SourceError("busy", `This agent already has ${mine} live streams open. Reuse one, or stop one before starting another.`);
    if (this.streams.size >= this.limits.total) throw new SourceError("busy", "Too many live streams are open. Try again in a moment.");
    const live: Live = { id: randomUUID(), key, agentId, frames: [], window: spec.window, seq: 0, state: "running", holders: 1, lastSeen: Date.now(), wake: new Set() };
    this.streams.set(live.id, live);
    this.byKey.set(key, live);
    const wake = () => {
      for (const listener of [...live.wake]) listener();
    };
    try {
      live.channel = await this.runner.stream(spec, args, context, {
        frame: (value) => {
          live.frames.push(value);
          if (live.frames.length > live.window) live.frames.splice(0, live.frames.length - live.window);
          live.seq++;
          wake();
        },
        end: (failure) => {
          if (live.state !== "running") return;
          live.state = failure ? "failed" : "ended";
          live.endedAt = Date.now();
          if (failure) live.error = failure;
          wake();
        },
      });
    } catch (error) {
      this.streams.delete(live.id);
      this.byKey.delete(key);
      throw error;
    }
    if (live.state !== "running") live.channel.stop();
    return { id: live.id, seq: live.seq };
  }

  private value(live: Live): unknown {
    if (live.frames.length === 0) return null;
    return live.window === 1 ? live.frames[live.frames.length - 1] : [...live.frames];
  }

  /** The stream's current value once it differs from `cursor`, waiting up to `waitMs` for a change. */
  async read(streamId: string, cursor: number, waitMs: number): Promise<StreamRead> {
    const live = this.streams.get(streamId);
    if (!live) return { cursor, state: "gone", changed: false, data: null };
    live.lastSeen = Date.now();
    const settled = () => live.seq !== cursor || live.state !== "running" || !this.streams.has(live.id);
    if (!settled() && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          live.wake.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        live.wake.add(done);
      });
      live.lastSeen = Date.now();
    }
    if (!this.streams.has(live.id)) return { cursor, state: "gone", changed: false, data: null };
    return { cursor: live.seq, state: live.state, changed: live.seq !== cursor, data: this.value(live), ...(live.error ? { error: live.error } : {}) };
  }

  /** Waits for the first frame, the end, or `ms`, so a call can answer with something. */
  async firstFrame(streamId: string, ms: number): Promise<StreamRead> {
    return this.read(streamId, 0, ms);
  }

  /** One holder lets go; the stream stops when the last one does. */
  release(streamId: string): void {
    const live = this.streams.get(streamId);
    if (!live) return;
    live.holders = Math.max(0, live.holders - 1);
    if (live.holders === 0) this.drop(live);
  }

  close(): void {
    clearInterval(this.reaper);
    for (const live of [...this.streams.values()]) this.drop(live);
    this.runner.close();
  }
}
