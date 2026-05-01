import { randomUUID } from "node:crypto";
import { RemoteError } from "./errors.js";
import type { SessionLiveEventBus } from "./live-events.js";
import type { StreamEventEnvelope } from "./schemas.js";

type StreamEventKind = StreamEventEnvelope["kind"];

interface StreamState {
  events: StreamEventEnvelope[];
  nextPosition: number;
  retentionKeysByEventId: Map<string, string>;
}

interface AppendEventInput<TKind extends StreamEventKind = StreamEventKind> {
  sessionId: string;
  kind: TKind;
  payload: Extract<StreamEventEnvelope, { kind: TKind }>["payload"];
  ts?: number;
  retentionKey?: string;
  sessionVersion?: string;
}

type AppendEventInputUnion = {
  [TKind in StreamEventKind]: AppendEventInput<TKind>;
}[StreamEventKind];

const OFFSET_READ_SEQ = "0000000000000000";
function formatOffset(position: number): string {
  return `${OFFSET_READ_SEQ}_${String(position).padStart(16, "0")}`;
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
      events: [],
      nextPosition: 0,
      retentionKeysByEventId: new Map(),
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
    this.publish(streamId, event);
    return event;
  }

  appendLiveOnly(streamId: string, input: AppendEventInputUnion): StreamEventEnvelope {
    const stream = this.getOrCreate(streamId);
    stream.nextPosition += 1;
    const event = createStreamEventEnvelope(
      randomUUID(),
      formatOffset(stream.nextPosition),
      input.ts ?? Date.now(),
      input,
    );
    this.publish(streamId, event);
    return event;
  }

  publish(streamId: string, event: StreamEventEnvelope): void {
    this.emitLiveEvent(streamId, event);
  }

  seedHeadOffset(streamId: string, position: number): void {
    const stream = this.getOrCreate(streamId);
    if (position <= stream.nextPosition) {
      return;
    }

    stream.nextPosition = position;
  }

  getHeadOffset(streamId: string): string {
    const stream = this.getOrCreate(streamId);
    return formatOffset(stream.nextPosition);
  }

  private getOrCreate(streamId: string): StreamState {
    const existing = this.streams.get(streamId);
    if (existing) {
      return existing;
    }

    const created: StreamState = {
      events: [],
      nextPosition: 0,
      retentionKeysByEventId: new Map(),
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
  }

  private emitLiveEvent(streamId: string, event: StreamEventEnvelope): void {
    this.liveEventBus?.publish(streamId, event);
  }
}

function createStreamEventEnvelope(
  eventId: string,
  streamOffset: string,
  ts: number,
  input: AppendEventInputUnion,
): StreamEventEnvelope {
  const base = {
    eventId,
    streamOffset,
    ts,
    ...(input.sessionVersion === undefined ? {} : { sessionVersion: input.sessionVersion }),
  };
  switch (input.kind) {
    case "session_created":
      return { ...base, ...input };
    case "session_closed":
      return { ...base, ...input };
    case "session_summary_updated":
      return { ...base, ...input };
    case "client_presence_updated":
      return { ...base, ...input };
    case "auth_notice":
      return { ...base, ...input };
    case "server_notice":
      return { ...base, ...input };
    case "agent_session_event":
      return { ...base, ...input };
    case "extension_event":
      return { ...base, ...input };
    case "extension_custom_event":
      return { ...base, ...input };
    case "command_accepted":
      return { ...base, ...input };
    case "session_state_patch":
      return { ...base, ...input };
    case "extension_ui_request":
      return { ...base, ...input };
    case "extension_ui_resolved":
      return { ...base, ...input };
    case "extension_error":
      return { ...base, ...input };
    case "bash_start":
      return { ...base, ...input };
    case "bash_chunk":
      return { ...base, ...input };
    case "bash_end":
      return { ...base, ...input };
    case "bash_flush":
      return { ...base, ...input };
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
}

export function appEventsStreamId(): string {
  return "app-events";
}

export function sessionEventsStreamId(sessionId: string): string {
  return `sessions/${sessionId}/events`;
}
