import {
  failureText,
  type SourceCallInput,
  type SourceCallResult,
  type SourceFailure,
  type SourceReadInput,
  type SourceReadResult,
} from "../shared/sources";

export interface SourceDeps {
  agentId: string;
  call(input: SourceCallInput): Promise<SourceCallResult>;
  read(input: SourceReadInput): Promise<SourceReadResult>;
  stop(input: { streamId: string }): Promise<unknown>;
  /** What the Query or Mutation named `name` in the program is for. */
  intent(name: string): "query" | "mutation";
  /** A stream delivered a new value, or failed: the queries that read `name` should look again. */
  onChange(name: string): void;
  /** A call or frame brought fresh data. */
  onResult?(): void;
  retry?: { baseMs: number; maxMs: number; attempts: number };
  /** How long one long poll may wait on the daemon. */
  holdMs?: number;
}

export interface SourceProvider {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Off while the app is in the background: streams close and calls answer from the last value. */
  setActive(active: boolean): void;
  /** Starts again every stream that failed, without waiting for its backoff. For a refresh the user asked for. */
  retry(): Promise<void>;
  /** Closes every stream. The provider can be used again afterwards. */
  shutdown(): void;
}

const RETRY = { baseMs: 1_000, maxMs: 30_000, attempts: 5 };
const HOLD_MS = 15_000;

interface Stream {
  key: string;
  name: string;
  args: Record<string, unknown>;
  id: string | undefined;
  cursor: number;
  data: unknown;
  failure: SourceFailure | undefined;
  failures: number;
  /** Bumped to retire the running loop. */
  generation: number;
  dormant: boolean;
  gaveUp: boolean;
}

function problem(failure: SourceFailure): Error {
  return Object.assign(new Error(failureText(failure)), { kind: failure.kind });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSourceProvider(deps: SourceDeps): SourceProvider {
  const retry = { ...RETRY, ...deps.retry };
  const hold = deps.holdMs ?? HOLD_MS;
  const streams = new Map<string, Stream>();
  const lastOnce = new Map<string, unknown>();
  const sleeping = new Set<{ timer: ReturnType<typeof setTimeout>; wake: () => void }>();
  let active = true;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const entry = {
        timer: setTimeout(() => {
          sleeping.delete(entry);
          resolve();
        }, ms),
        wake: resolve,
      };
      sleeping.add(entry);
    });

  const call = async (name: string, args: Record<string, unknown>): Promise<SourceCallResult> => {
    try {
      return await deps.call({ agentId: deps.agentId, source: name, args, intent: deps.intent(name) });
    } catch (error) {
      return { ok: false, error: { kind: "network", message: `Could not reach the daemon to run "${name}": ${reason(error)}` } };
    }
  };

  const release = (stream: Stream) => {
    stream.generation++;
    if (stream.id) void deps.stop({ streamId: stream.id }).catch(() => undefined);
    stream.id = undefined;
  };

  /** Adopts what a call returned for a stream, and starts listening. Throws the failure otherwise. */
  const attach = (stream: Stream, result: SourceCallResult): void => {
    if (!result.ok) {
      stream.failure = result.error;
      stream.failures++;
      throw problem(result.error);
    }
    stream.id = result.streamId;
    stream.cursor = result.cursor ?? 0;
    stream.data = result.data;
    stream.failure = undefined;
    stream.dormant = false;
    stream.gaveUp = false;
    deps.onResult?.();
    if (result.streamId) listen(stream);
  };

  const recover = async (stream: Stream, generation: number, first: SourceFailure): Promise<void> => {
    let failure = first;
    for (;;) {
      if (stream.generation !== generation) return;
      stream.failure = failure;
      stream.failures++;
      if (stream.failures >= retry.attempts) {
        stream.gaveUp = true;
        stream.failure = { ...failure, message: `${failure.message} Gave up after ${retry.attempts} tries; tap refresh to try again.` };
        deps.onChange(stream.name);
        return;
      }
      deps.onChange(stream.name);
      await sleep(Math.min(retry.maxMs, retry.baseMs * 2 ** (stream.failures - 1)));
      if (stream.generation !== generation) return;
      const result = await call(stream.name, stream.args);
      if (stream.generation !== generation) {
        if (result.ok && result.streamId) void deps.stop({ streamId: result.streamId }).catch(() => undefined);
        return;
      }
      if (result.ok && result.mode === "stream") {
        const failures = stream.failures;
        stream.generation++;
        attach(stream, result);
        stream.failures = failures;
        deps.onChange(stream.name);
        return;
      }
      failure = result.ok ? { kind: "internal", message: `"${stream.name}" stopped being a stream.` } : result.error;
    }
  };

  const listen = (stream: Stream): void => {
    const generation = ++stream.generation;
    void (async () => {
      while (stream.generation === generation && stream.id) {
        let result: SourceReadResult;
        try {
          result = await deps.read({ streamId: stream.id, cursor: stream.cursor, waitMs: hold });
        } catch (error) {
          if (stream.generation === generation) await recover(stream, generation, { kind: "network", message: `Lost the connection to the daemon: ${reason(error)}` });
          return;
        }
        if (stream.generation !== generation) return;
        stream.cursor = result.cursor;
        if (result.changed) {
          stream.data = result.data;
          stream.failure = undefined;
          stream.failures = 0;
          deps.onResult?.();
          deps.onChange(stream.name);
        }
        if (result.state === "running") continue;
        if (result.state === "ended") return;
        const gone: SourceFailure = { kind: "stopped", message: result.state === "gone" ? "The stream was closed on the daemon." : "The stream stopped." };
        await recover(stream, generation, result.error ?? gone);
        return;
      }
    })();
  };

  const reopen = async (stream: Stream): Promise<void> => {
    stream.generation++;
    stream.failures = 0;
    attach(stream, await call(stream.name, stream.args));
  };

  return {
    async callTool(name, args) {
      const key = `${name}\0${JSON.stringify(args)}`;
      const known = streams.get(key);
      if (known) {
        if (known.failure && !known.dormant) throw problem(known.failure);
        return known.data;
      }
      if (!active && lastOnce.has(key)) return lastOnce.get(key);
      const result = await call(name, args);
      if (!result.ok) throw problem(result.error);
      if (result.mode === "once") {
        lastOnce.set(key, result.data);
        deps.onResult?.();
        return result.data;
      }
      const stream: Stream = { key, name, args, id: undefined, cursor: 0, data: null, failure: undefined, failures: 0, generation: 0, dormant: false, gaveUp: false };
      streams.set(key, stream);
      attach(stream, result);
      return stream.data;
    },

    setActive(next) {
      if (next === active) return;
      active = next;
      for (const entry of sleeping) {
        clearTimeout(entry.timer);
        entry.wake();
      }
      sleeping.clear();
      for (const stream of streams.values()) {
        if (!next) {
          release(stream);
          stream.dormant = true;
        } else if (stream.dormant) {
          void reopen(stream).then(
            () => deps.onChange(stream.name),
            () => {
              stream.dormant = false;
              void recover(stream, stream.generation, stream.failure ?? { kind: "stopped", message: "The stream could not be reopened." });
            },
          );
        }
      }
    },

    async retry() {
      const failed = [...streams.values()].filter((stream) => stream.failure && !stream.dormant);
      await Promise.all(
        failed.map((stream) =>
          reopen(stream).then(
            () => deps.onChange(stream.name),
            () => deps.onChange(stream.name),
          ),
        ),
      );
    },

    shutdown() {
      for (const entry of sleeping) {
        clearTimeout(entry.timer);
        entry.wake();
      }
      sleeping.clear();
      for (const stream of streams.values()) release(stream);
      streams.clear();
      lastOnce.clear();
    },
  };
}
