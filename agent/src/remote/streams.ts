import { randomUUID } from "node:crypto";
import { RemoteError } from "./errors.js";
import type { SessionLiveEventBus } from "./live-events.js";
import type { StreamEventEnvelope } from "./schemas.js";

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
  firstRetainedPosition: number;
  nextPosition: number;
  retentionKeysByEventId: Map<string, string>;
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
  payload: Extract<StreamEventEnvelope, { kind: TKind }>["payload"];
  ts?: number;
  retentionKey?: string;
}

type AppendEventInputUnion = {
  [TKind in StreamEventKind]: AppendEventInput<TKind>;
}[StreamEventKind];

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
  private readonly maxRetainedEventsPerStream: number;
  private readonly liveEventBus: SessionLiveEventBus | undefined;

  constructor(options?: {
    maxRetainedEventsPerStream?: number;
    liveEventBus?: SessionLiveEventBus;
  }) {
    this.maxRetainedEventsPerStream = options?.maxRetainedEventsPerStream ?? 512;
    this.liveEventBus = options?.liveEventBus;
  }

  ensureStream(streamId: string): void {
    if (this.streams.has(streamId)) {
      return;
    }
    this.streams.set(streamId, {
      id: streamId,
      events: [],
      firstRetainedPosition: 1,
      nextPosition: 0,
      retentionKeysByEventId: new Map(),
      listeners: new Set(),
      closed: false,
    });
  }

  append(streamId: string, input: AppendEventInputUnion): StreamEventEnvelope {
    const stream = this.getOrCreate(streamId);
    if (input.retentionKey !== undefined && input.retentionKey.length > 0) {
      dropRetainedEventsByKey(stream, input.retentionKey);
    }
    stream.nextPosition += 1;
    const streamOffset = formatOffset(stream.nextPosition);
    const event = createStreamEventEnvelope(
      randomUUID(),
      streamOffset,
      input.ts ?? Date.now(),
      input,
    );
    stream.events.push(event);
    if (input.retentionKey !== undefined && input.retentionKey.length > 0) {
      stream.retentionKeysByEventId.set(event.eventId, input.retentionKey);
    }
    this.trimRetainedEvents(stream);
    this.liveEventBus?.publish(streamId, event);
    for (const listener of stream.listeners) {
      listener(event);
    }
    return event;
  }

  seedHeadOffset(streamId: string, position: number): void {
    const stream = this.getOrCreate(streamId);
    if (position <= stream.nextPosition) {
      return;
    }

    stream.nextPosition = position;
    if (stream.events.length === 0) {
      stream.firstRetainedPosition = position + 1;
    }
  }

  read(streamId: string, offset: string | undefined): StreamReadResult {
    const stream = this.getOrCreate(streamId);
    const nextOffset = formatOffset(stream.nextPosition);
    const resolvedOffset = resolveOffset(offset, nextOffset);
    const requestedPosition = parseResolvedOffsetPosition(resolvedOffset);
    const events = selectRetainedEvents(stream, requestedPosition);
    return {
      events,
      fromOffset: resolvedOffset ?? null,
      nextOffset,
      upToDate: requestedPosition >= stream.firstRetainedPosition - 1,
      streamClosed: stream.closed,
    };
  }

  getHeadOffset(streamId: string): string {
    const stream = this.getOrCreate(streamId);
    return formatOffset(stream.nextPosition);
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
    const nextOffset = formatOffset(stream.nextPosition);
    const resolvedOffset = resolveOffset(offset, nextOffset);
    const requestedPosition = parseResolvedOffsetPosition(resolvedOffset);
    const events = selectRetainedEvents(stream, requestedPosition);
    const read: StreamReadResult = {
      events,
      fromOffset: resolvedOffset ?? null,
      nextOffset,
      upToDate: requestedPosition >= stream.firstRetainedPosition - 1,
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
      firstRetainedPosition: 1,
      nextPosition: 0,
      retentionKeysByEventId: new Map(),
      listeners: new Set(),
      closed: false,
    };
    this.streams.set(streamId, created);
    return created;
  }

  private trimRetainedEvents(stream: StreamState): void {
    if (stream.events.length <= this.maxRetainedEventsPerStream) {
      return;
    }

    const deleteCount = stream.events.length - this.maxRetainedEventsPerStream;
    const removedEvents = stream.events.splice(0, deleteCount);
    for (const removedEvent of removedEvents) {
      stream.retentionKeysByEventId.delete(removedEvent.eventId);
    }
    stream.firstRetainedPosition += deleteCount;
  }
}

function createStreamEventEnvelope(
  eventId: string,
  streamOffset: string,
  ts: number,
  input: AppendEventInputUnion,
): StreamEventEnvelope {
  switch (input.kind) {
    case "session_created":
      return { eventId, streamOffset, ts, ...input };
    case "session_closed":
      return { eventId, streamOffset, ts, ...input };
    case "session_summary_updated":
      return { eventId, streamOffset, ts, ...input };
    case "client_presence_updated":
      return { eventId, streamOffset, ts, ...input };
    case "auth_notice":
      return { eventId, streamOffset, ts, ...input };
    case "server_notice":
      return { eventId, streamOffset, ts, ...input };
    case "agent_session_event":
      return { eventId, streamOffset, ts, ...input };
    case "extension_event":
      return { eventId, streamOffset, ts, ...input };
    case "extension_custom_event":
      return { eventId, streamOffset, ts, ...input };
    case "command_accepted":
      return { eventId, streamOffset, ts, ...input };
    case "session_state_patch":
      return { eventId, streamOffset, ts, ...input };
    case "extension_ui_request":
      return { eventId, streamOffset, ts, ...input };
    case "extension_ui_resolved":
      return { eventId, streamOffset, ts, ...input };
    case "extension_error":
      return { eventId, streamOffset, ts, ...input };
    case "bash_start":
      return { eventId, streamOffset, ts, ...input };
    case "bash_chunk":
      return { eventId, streamOffset, ts, ...input };
    case "bash_end":
      return { eventId, streamOffset, ts, ...input };
    case "bash_flush":
      return { eventId, streamOffset, ts, ...input };
  }

  throw new RemoteError("Unsupported stream event kind", 500);
}

function dropRetainedEventsByKey(stream: StreamState, retentionKey: string): void {
  const removedEventIds = stream.events
    .filter((event) => stream.retentionKeysByEventId.get(event.eventId) === retentionKey)
    .map((event) => event.eventId);
  const nextEvents = stream.events.filter((event) => !removedEventIds.includes(event.eventId));
  if (nextEvents.length === stream.events.length) {
    return;
  }

  for (const removedEventId of removedEventIds) {
    stream.retentionKeysByEventId.delete(removedEventId);
  }

  stream.events = nextEvents;
  if (stream.events.length === 0) {
    stream.firstRetainedPosition = stream.nextPosition + 1;
    return;
  }

  const firstEvent = stream.events[0];
  if (firstEvent === undefined) {
    return;
  }

  stream.firstRetainedPosition = parseResolvedOffsetPosition(firstEvent.streamOffset);
}

function parseResolvedOffsetPosition(offset: string | undefined): number {
  if (offset === undefined || offset === "-1") {
    return -1;
  }

  const separatorIndex = offset.indexOf("_");
  if (separatorIndex === -1) {
    return -1;
  }

  const parsed = Number.parseInt(offset.slice(separatorIndex + 1), 10);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function selectRetainedEvents(
  stream: StreamState,
  requestedPosition: number,
): StreamEventEnvelope[] {
  if (requestedPosition < stream.firstRetainedPosition - 1) {
    return [...stream.events];
  }

  return stream.events.filter(
    (event) => parseResolvedOffsetPosition(event.streamOffset) > requestedPosition,
  );
}

export function appEventsStreamId(): string {
  return "app-events";
}

export function sessionEventsStreamId(sessionId: string): string {
  return `sessions/${sessionId}/events`;
}
