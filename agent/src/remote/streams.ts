import { randomUUID } from "node:crypto";
import { RemoteError } from "./errors.js";
import { StreamEventEnvelopeSchema, type StreamEventEnvelope } from "./schemas.js";
import { assertType } from "./typebox.js";

type StreamEventKind = StreamEventEnvelope["kind"];

export interface StreamReadResult {
  events: StreamEventEnvelope[];
  nextOffset: string;
  fromOffset: string | null;
  upToDate: boolean;
  streamClosed: boolean;
}

export interface StreamLongPollResult extends StreamReadResult {
  timedOut: boolean;
}

type StreamListener = (event: StreamEventEnvelope) => void;

interface StreamState {
  id: string;
  events: StreamEventEnvelope[];
  listeners: Set<StreamListener>;
  closed: boolean;
}

export interface StreamSubscription {
  read: StreamReadResult;
  unsubscribe: () => void;
}

interface AppendEventInput<TKind extends StreamEventKind = StreamEventKind> {
  sessionId: string;
  kind: TKind;
  payload: StreamEventEnvelope["payload"];
  ts?: number;
}

const OFFSET_READ_SEQ = "0000000000000000";
const OFFSET_PATTERN = /^\d{16}_\d{16}$/;

function formatOffset(position: number): string {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new RemoteError("Invalid stream position", 500);
  }
  return `${OFFSET_READ_SEQ}_${String(position).padStart(16, "0")}`;
}

function resolveOffset(offset: string | undefined, nextOffset: string): string | undefined {
  if (offset === undefined) {
    return undefined;
  }
  if (offset === "-1") {
    return "-1";
  }
  if (offset === "now") {
    return nextOffset;
  }
  if (offset === "HEAD") {
    return nextOffset;
  }
  if (!OFFSET_PATTERN.test(offset)) {
    throw new RemoteError("Invalid stream offset", 400);
  }
  return offset;
}

export class InMemoryDurableStreamStore {
  private readonly streams = new Map<string, StreamState>();

  ensureStream(streamId: string): void {
    if (this.streams.has(streamId)) {
      return;
    }
    this.streams.set(streamId, {
      id: streamId,
      events: [],
      listeners: new Set(),
      closed: false,
    });
  }

  append<TKind extends StreamEventKind>(
    streamId: string,
    input: AppendEventInput<TKind>,
  ): StreamEventEnvelope {
    const stream = this.getOrCreate(streamId);
    const streamOffset = formatOffset(stream.events.length + 1);
    const eventCandidate: unknown = {
      eventId: randomUUID(),
      sessionId: input.sessionId,
      streamOffset,
      ts: input.ts ?? Date.now(),
      kind: input.kind,
      payload: input.payload,
    };
    assertType(StreamEventEnvelopeSchema, eventCandidate);
    const event = eventCandidate;
    stream.events.push(event);
    for (const listener of stream.listeners) {
      listener(event);
    }
    return event;
  }

  read(streamId: string, offset: string | undefined): StreamReadResult {
    const stream = this.getOrCreate(streamId);
    const nextOffset = formatOffset(stream.events.length);
    const resolvedOffset = resolveOffset(offset, nextOffset);
    const events =
      resolvedOffset !== undefined && resolvedOffset.length > 0
        ? stream.events.filter((event) => event.streamOffset > resolvedOffset)
        : [...stream.events];
    return {
      events,
      fromOffset: resolvedOffset ?? null,
      nextOffset,
      upToDate: true,
      streamClosed: stream.closed,
    };
  }

  getHeadOffset(streamId: string): string {
    const stream = this.getOrCreate(streamId);
    return formatOffset(stream.events.length);
  }

  subscribe(streamId: string, listener: StreamListener): () => void {
    const stream = this.getOrCreate(streamId);
    stream.listeners.add(listener);
    return () => {
      stream.listeners.delete(listener);
    };
  }

  readAndSubscribe(
    streamId: string,
    offset: string | undefined,
    listener: StreamListener,
  ): StreamSubscription {
    const stream = this.getOrCreate(streamId);
    const nextOffset = formatOffset(stream.events.length);
    const resolvedOffset = resolveOffset(offset, nextOffset);
    const events =
      resolvedOffset !== undefined && resolvedOffset.length > 0
        ? stream.events.filter((event) => event.streamOffset > resolvedOffset)
        : [...stream.events];
    const read: StreamReadResult = {
      events,
      fromOffset: resolvedOffset ?? null,
      nextOffset,
      upToDate: true,
      streamClosed: stream.closed,
    };

    if (stream.closed) {
      return {
        read,
        unsubscribe: () => {},
      };
    }

    stream.listeners.add(listener);
    return {
      read,
      unsubscribe: () => {
        stream.listeners.delete(listener);
      },
    };
  }

  waitForEvents(
    streamId: string,
    offset: string | undefined,
    timeoutMs: number,
  ): Promise<StreamLongPollResult> {
    let settle:
      | ((value: StreamLongPollResult | PromiseLike<StreamLongPollResult>) => void)
      | undefined;
    let done = false;
    let timeout: NodeJS.Timeout | undefined;

    let frozenOffset = "-1";

    const finalize = (
      unsubscribe: () => void,
      result: StreamReadResult,
      timedOut: boolean,
    ): void => {
      if (done) {
        return;
      }
      done = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      unsubscribe();
      settle?.({ ...result, timedOut });
    };

    const subscription = this.readAndSubscribe(streamId, offset, () => {
      finalize(subscription.unsubscribe, this.read(streamId, frozenOffset), false);
    });

    const current = subscription.read;
    frozenOffset = current.fromOffset ?? current.nextOffset;

    if (current.events.length > 0 || current.streamClosed) {
      subscription.unsubscribe();
      return Promise.resolve({ ...current, timedOut: false });
    }

    return new Promise<StreamLongPollResult>((resolve) => {
      settle = resolve;
      timeout = setTimeout(() => {
        finalize(subscription.unsubscribe, this.read(streamId, frozenOffset), true);
      }, timeoutMs);
    });
  }

  private getOrCreate(streamId: string): StreamState {
    const existing = this.streams.get(streamId);
    if (existing) {
      return existing;
    }

    const created: StreamState = {
      id: streamId,
      events: [],
      listeners: new Set(),
      closed: false,
    };
    this.streams.set(streamId, created);
    return created;
  }
}

export function appEventsStreamId(): string {
  return "app-events";
}

export function sessionEventsStreamId(sessionId: string): string {
  return `sessions/${sessionId}/events`;
}
