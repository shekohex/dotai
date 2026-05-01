import { randomUUID } from "node:crypto";
import { RemoteError } from "./errors.js";
import type { SessionLiveEventBus } from "./live-events.js";
import type { StreamEventEnvelope } from "./schemas.js";

type StreamEventKind = StreamEventEnvelope["kind"];

interface StreamState {
  nextPosition: number;
}

interface AppendEventInput<TKind extends StreamEventKind = StreamEventKind> {
  sessionId: string;
  kind: TKind;
  payload: Extract<StreamEventEnvelope, { kind: TKind }>["payload"];
  ts?: number;
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

  ensureStream(streamId: string): void {
    if (this.streams.has(streamId)) {
      return;
    }
    this.streams.set(streamId, {
      nextPosition: 0,
    });
  }

  append(streamId: string, input: AppendEventInputUnion): StreamEventEnvelope {
    const stream = this.getOrCreate(streamId);
    stream.nextPosition += 1;
    return createStreamEventEnvelope(
      randomUUID(),
      formatOffset(stream.nextPosition),
      input.ts ?? Date.now(),
      input,
    );
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
    return event;
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
      nextPosition: 0,
    };
    this.streams.set(streamId, created);
    return created;
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

export function appEventsStreamId(): string {
  return "app-events";
}

export function sessionEventsStreamId(sessionId: string): string {
  return `sessions/${sessionId}/events`;
}

export function publishLiveEvent(
  liveEvents: SessionLiveEventBus | undefined,
  streamId: string,
  event: StreamEventEnvelope,
): StreamEventEnvelope {
  liveEvents?.publish(streamId, event);
  return event;
}

export function appendAndPublish(
  streams: InMemoryDurableStreamStore,
  liveEvents: SessionLiveEventBus | undefined,
  streamId: string,
  input: Parameters<InMemoryDurableStreamStore["append"]>[1],
): StreamEventEnvelope {
  return publishLiveEvent(liveEvents, streamId, streams.append(streamId, input));
}

export function appendLiveOnlyAndPublish(
  streams: InMemoryDurableStreamStore,
  liveEvents: SessionLiveEventBus | undefined,
  streamId: string,
  input: Parameters<InMemoryDurableStreamStore["appendLiveOnly"]>[1],
): StreamEventEnvelope {
  return publishLiveEvent(liveEvents, streamId, streams.appendLiveOnly(streamId, input));
}
