import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** What a source can be told to do. Everything but `type` is optional and filled by `withDefaults`. */
export const sourceSpecSchema = z.object({
  type: z.enum(["command", "http", "websocket"]),
  run: z.string().max(10_000).optional(),
  cwd: z.string().max(2_000).optional(),
  url: z.string().max(4_000).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
  mode: z.enum(["once", "stream"]).optional(),
  timeoutSeconds: z.number().min(0).max(3_600).optional(),
  window: z.number().int().min(1).max(500).optional(),
  access: z.enum(["read", "write"]).optional(),
  args: z.string().max(1_000).optional(),
  returns: z.string().max(1_000).optional(),
});

export type SourceSpecInput = z.infer<typeof sourceSpecSchema>;

export interface SourceSpec extends SourceSpecInput {
  mode: "once" | "stream";
  timeoutSeconds: number;
  window: number;
  access: "read" | "write";
}

export const DEFAULT_ONCE_TIMEOUT = 10;
export const DEFAULT_STREAM_IDLE = 30;
export const MAX_ARGS_BYTES = 64_000;

/** A ws:// or wss:// url is a WebSocket whatever `type` says. */
export function isSocketUrl(url: string | undefined): boolean {
  return /^wss?:\/\//i.test(url ?? "");
}

export function withDefaults(spec: SourceSpecInput): SourceSpec {
  const mode = spec.mode ?? (isSocketUrl(spec.url) ? "stream" : "once");
  return {
    ...spec,
    mode,
    timeoutSeconds: spec.timeoutSeconds ?? (mode === "stream" ? DEFAULT_STREAM_IDLE : DEFAULT_ONCE_TIMEOUT),
    window: spec.window ?? 1,
    access: spec.access ?? "read",
  };
}

/** Problems with a spec that no run could get past; empty when it is usable. */
export function specProblems(spec: SourceSpec): string[] {
  const problems: string[] = [];
  if (spec.type === "command" && !spec.run?.trim()) problems.push("A command source needs `run`: the shell command line to execute.");
  if (spec.type !== "command") {
    if (!spec.url) problems.push("A url source needs `url`.");
    else if (!/^(https?|wss?):\/\//i.test(spec.url)) problems.push("`url` must start with http://, https://, ws:// or wss://.");
  }
  if (spec.mode === "stream" && spec.access === "write") problems.push("A stream only reads. Use mode once for a source that changes something.");
  if (spec.mode === "once" && spec.timeoutSeconds <= 0) problems.push("timeoutSeconds must be above 0 for mode once, or the call could hang forever.");
  if (spec.mode === "once" && spec.window > 1) problems.push("`window` only applies to mode stream.");
  return problems;
}

/** The url with `{name}` filled from args, and the args that no placeholder used. */
export function fillPath(url: string, args: Record<string, unknown>): { url: string; rest: Record<string, unknown> } {
  const rest = { ...args };
  const filled = url.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string, offset: number) => {
    if (url[offset - 1] === "$") return match;
    const value = rest[name];
    if (value === undefined || value === null || value === "") throw new SourceError("bad-args", `The url needs the argument "${name}". Pass it in the Query or Mutation args.`);
    delete rest[name];
    return encodeURIComponent(typeof value === "string" ? value : JSON.stringify(value));
  });
  return { url: filled, rest };
}

/** Why a call failed, in terms the agent and the user can act on. */
export const SOURCE_ERROR_KINDS = [
  "unknown-source",
  "forbidden",
  "invalid-source",
  "bad-args",
  "spawn",
  "timeout",
  "exit",
  "output",
  "parse",
  "rpc",
  "http",
  "network",
  "busy",
  "stopped",
  "internal",
] as const;

export const sourceErrorSchema = z.object({
  kind: z.enum(SOURCE_ERROR_KINDS),
  message: z.string(),
  detail: z.string().optional(),
});

export type SourceFailure = z.infer<typeof sourceErrorSchema>;

export interface SourceError extends Error {
  readonly kind: SourceFailure["kind"];
  readonly detail: string | undefined;
  toFailure(): SourceFailure;
}

interface SourceErrorConstructor {
  new (kind: SourceFailure["kind"], message: string, detail?: string): SourceError;
  prototype: SourceError;
}

/** Built on the prototype chain, not `class`: Hermes leaves class declarations in this bundle undefined. */
export const SourceError = function SourceError(this: { -readonly [K in keyof SourceError]: SourceError[K] }, kind: SourceFailure["kind"], message: string, detail?: string) {
  this.name = "SourceError";
  this.message = message;
  this.kind = kind;
  this.detail = detail;
  this.stack = new Error(message).stack;
} as unknown as SourceErrorConstructor;

SourceError.prototype = Object.create(Error.prototype, {
  constructor: { value: SourceError },
  toFailure: {
    value(this: SourceError): SourceFailure {
      return { kind: this.kind, message: this.message, ...(this.detail ? { detail: this.detail } : {}) };
    },
  },
}) as SourceError;

export function failureText(failure: SourceFailure): string {
  return failure.detail ? `${failure.message} (${failure.detail})` : failure.message;
}

const PREVIEW = 160;

export function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW)}…` : flat;
}

/** A JSON-RPC 2.0 reply gives up its result, or its error as a failure; anything else is the value itself. */
export function unwrapRpc(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const reply = value as Record<string, unknown>;
  if (reply.jsonrpc !== "2.0") return value;
  if (reply.error !== undefined && reply.error !== null) {
    const error = reply.error as { message?: unknown; code?: unknown };
    const message = typeof error === "object" && typeof error.message === "string" ? error.message : preview(JSON.stringify(reply.error));
    throw new SourceError("rpc", `The source answered with a JSON-RPC error: ${message}`, typeof error === "object" && error.code !== undefined ? `code ${String(error.code)}` : undefined);
  }
  return "result" in reply ? reply.result : null;
}

/** One value from the whole output of a run: a JSON document, or the last line of newline-delimited JSON. */
export function parseOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") throw new SourceError("parse", "The source printed nothing. It must print a JSON value to stdout.");
  try {
    return unwrapRpc(JSON.parse(trimmed));
  } catch (error) {
    if (error instanceof SourceError) throw error;
  }
  const lines = trimmed.split(/\r?\n/).map(streamLine).filter((line): line is string => line !== undefined);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      return unwrapRpc(JSON.parse(lines[index] ?? ""));
    } catch (error) {
      if (error instanceof SourceError) throw error;
    }
  }
  throw new SourceError("parse", "The output is not JSON. Print one JSON value (or one JSON object per line).", `starts with: ${preview(trimmed)}`);
}

export const STREAM_DONE = Symbol("stream-done");

/**
 * The JSON text a stream line carries, or undefined to skip it: blank lines, SSE comments and
 * fields other than data. `data: [DONE]` ends the stream.
 */
export function streamLine(line: string): string | undefined {
  const text = line.trim();
  if (text === "" || text.startsWith(":")) return undefined;
  if (/^(event|id|retry):/.test(text)) return undefined;
  if (text.startsWith("data:")) {
    const data = text.slice(5).trim();
    return data === "" ? undefined : data;
  }
  return text;
}

/** The value a stream line holds, STREAM_DONE for `[DONE]`, or undefined for lines to skip. Throws SourceError on bad JSON. */
export function parseFrame(line: string): unknown | typeof STREAM_DONE | undefined {
  const text = streamLine(line);
  if (text === undefined) return undefined;
  if (text === "[DONE]") return STREAM_DONE;
  try {
    return unwrapRpc(JSON.parse(text));
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("parse", "A line of the stream is not JSON.", `line: ${preview(text)}`);
  }
}

/** `${NAME}` becomes the daemon's environment value, so secrets need not sit in a saved source. */
export function expandEnv(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? "");
}

// ── RPC between the app and the daemon ──────────────────────────────────────

const callOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    mode: z.enum(["once", "stream"]),
    data: z.unknown(),
    streamId: z.string().optional(),
    cursor: z.number().optional(),
  }),
  z.object({ ok: z.literal(false), error: sourceErrorSchema }),
]);

const readOutputSchema = z.object({
  cursor: z.number(),
  state: z.enum(["running", "ended", "failed", "gone"]),
  changed: z.boolean(),
  data: z.unknown(),
  error: sourceErrorSchema.optional(),
});

const callInputSchema = z
  .object({
    agentId: z.string(),
    source: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
    intent: z.enum(["query", "mutation"]),
  })
  .strict();

const readInputSchema = z.object({ streamId: z.string(), cursor: z.number(), waitMs: z.number().min(0).max(25_000) }).strict();
const stopInputSchema = z.object({ streamId: z.string() }).strict();

export type SourceCallInput = z.infer<typeof callInputSchema>;
export type SourceCallResult = z.infer<typeof callOutputSchema>;
export type SourceReadInput = z.infer<typeof readInputSchema>;
export type SourceReadResult = z.infer<typeof readOutputSchema>;

export const sourceCallRpc = defineRpc({ name: "openui.source.call", input: callInputSchema, output: callOutputSchema });
export const sourceReadRpc = defineRpc({ name: "openui.source.read", input: readInputSchema, output: readOutputSchema });
export const sourceStopRpc = defineRpc({ name: "openui.source.stop", input: stopInputSchema, output: z.object({ ok: z.literal(true) }) });
