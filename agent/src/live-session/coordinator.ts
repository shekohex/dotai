import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SubagentChildIpcEvent } from "../subagent-sdk/ipc.js";
import {
  SUBAGENT_PARENT_MESSAGE_TYPE,
  type SubagentParentMessage,
} from "../subagent-sdk/parent-message.js";
import type { RuntimeSubagent, SubagentDelivery } from "../subagent-sdk/types.js";
import type { SubagentSDK } from "../subagent-sdk/sdk.js";

const MAX_THREAD_EVENTS = 256;
const COMMENTARY_BATCH_MS = 200;

export type LiveThreadStatus = RuntimeSubagent["status"] | "interrupted";

export type LiveThreadActivity = {
  kind: "thinking" | "commentary" | "tool" | "message" | "waiting";
  label: string;
  detail?: string;
  toolName?: string;
  startedAt: number;
  updatedAt: number;
};

export type LiveThreadSnapshot = {
  id: string;
  parentId?: string;
  path: string;
  name: string;
  task: string;
  status: LiveThreadStatus;
  activity?: LiveThreadActivity;
  latestCommentary?: string;
  finalSummary?: string;
  updatedAt: number;
};

export type LiveCoordinatorEvent = {
  coordinatorId: string;
  sequence: number;
  type:
    | "thread.started"
    | "thread.status"
    | "thread.activity"
    | "thread.commentary"
    | "thread.message"
    | "thread.completed";
  threadId: string;
  timestamp: number;
  data: Record<string, unknown>;
};

export type LiveThreadInspection = {
  thread: LiveThreadSnapshot;
  events: LiveCoordinatorEvent[];
};

export type LiveCoordinatorSnapshot = {
  coordinatorId: string;
  sequence: number;
  threads: LiveThreadSnapshot[];
};

export interface LiveSessionThreadRuntime {
  list(): RuntimeSubagent[];
  message(
    params: { sessionId: string; message: string; delivery: SubagentDelivery },
    ctx: ExtensionContext,
  ): Promise<RuntimeSubagent>;
  interrupt(params: { sessionId: string }): Promise<RuntimeSubagent>;
  onState(listener: (state: RuntimeSubagent) => void): () => void;
  onChildEvent(listener: (sessionId: string, event: SubagentChildIpcEvent) => void): () => void;
  onParentMessage(
    listener: (sessionId: string, message: SubagentParentMessage) => void,
  ): () => void;
}

type RootSessionInput = {
  sessionId: string;
  name: string;
  cwd: string;
  updatedAt: number;
};

function threadPath(name: string): string {
  const segment = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return `/root/${segment || "thread"}`;
}

function readCommentaryDelta(event: SubagentChildIpcEvent): string | undefined {
  if (event.type !== "message_update") return undefined;
  const assistantEvent = event.assistantMessageEvent;
  if (assistantEvent.type !== "thinking_delta" && assistantEvent.type !== "text_delta") {
    return undefined;
  }
  const delta = assistantEvent.delta;
  return delta.length > 0 ? delta : undefined;
}

function liveActivityKind(
  kind: RuntimeSubagent["activity"] extends infer TActivity
    ? TActivity extends { kind: infer TKind }
      ? TKind
      : never
    : never,
): LiveThreadActivity["kind"] {
  switch (kind) {
    case "thinking":
    case "tool":
    case "message":
      return kind;
    case "idle":
    case "completed":
    case "failed":
    case "cancelled":
      return "waiting";
    default:
      return "waiting";
  }
}

function snapshotFromState(state: RuntimeSubagent): LiveThreadSnapshot {
  const activity = state.activity;
  return {
    id: state.sessionId,
    parentId: state.parentSessionId,
    path: threadPath(state.name),
    name: state.name,
    task: state.task,
    status: state.status,
    ...(activity === undefined
      ? {}
      : {
          activity: {
            kind: liveActivityKind(activity.kind),
            label: activity.label,
            ...(activity.detail === undefined ? {} : { detail: activity.detail }),
            ...(activity.toolName === undefined ? {} : { toolName: activity.toolName }),
            startedAt: activity.startedAt,
            updatedAt: activity.updatedAt,
          },
        }),
    ...(state.summary === undefined ? {} : { finalSummary: state.summary }),
    updatedAt: state.updatedAt,
  };
}

export class LiveSessionCoordinator {
  readonly #pi: ExtensionAPI;
  #coordinatorId = crypto.randomUUID();
  readonly #threads = new Map<string, LiveThreadSnapshot>();
  readonly #events = new Map<string, LiveCoordinatorEvent[]>();
  readonly #listeners = new Set<(event: LiveCoordinatorEvent) => void>();
  readonly #commentaryBuffers = new Map<
    string,
    { text: string; timer: ReturnType<typeof setTimeout> }
  >();
  #runtime: LiveSessionThreadRuntime | undefined;
  #root: LiveThreadSnapshot | undefined;
  #sequence = 0;
  #unsubscribeRuntime: Array<() => void> = [];

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  bindThreadRuntime(runtime: LiveSessionThreadRuntime): void {
    for (const unsubscribe of this.#unsubscribeRuntime) unsubscribe();
    this.#unsubscribeRuntime = [];
    this.#runtime = runtime;
    for (const state of runtime.list()) this.#recordState(state);
    this.#unsubscribeRuntime.push(
      runtime.onState((state) => {
        this.#recordState(state);
      }),
      runtime.onChildEvent((sessionId, event) => {
        this.#recordChildEvent(sessionId, event);
      }),
      runtime.onParentMessage((sessionId, message) => {
        this.#deliverParentMessage(sessionId, message);
      }),
    );
  }

  bindSubagentSDK(sdk: SubagentSDK): void {
    this.bindThreadRuntime({
      list: () => sdk.list(),
      async message(params, ctx) {
        return (await sdk.message(params, ctx)).result.state;
      },
      interrupt: (params) => sdk.interrupt(params),
      onState: (listener) =>
        sdk.onEvent((event) => {
          listener(event.state);
        }),
      onChildEvent: (listener) =>
        sdk.onAnyChildEvent((event, sessionId) => {
          listener(sessionId, event);
        }),
      onParentMessage: (listener) =>
        sdk.onParentMessage(({ sessionId, message }) => {
          listener(sessionId, message);
        }),
    });
  }

  setRootSession(input: RootSessionInput): void {
    this.#root = {
      id: input.sessionId,
      path: "/root",
      name: input.name,
      task: input.cwd,
      status: "idle",
      updatedAt: input.updatedAt,
    };
  }

  setRootStatus(status: "running" | "idle", updatedAt = Date.now()): void {
    if (this.#root === undefined) return;
    this.#root = { ...this.#root, status, updatedAt };
  }

  listThreads(): LiveThreadSnapshot[] {
    return [
      ...(this.#root === undefined ? [] : [{ ...this.#root }]),
      ...Array.from(this.#threads.values())
        .toSorted((left, right) => left.updatedAt - right.updatedAt)
        .map((thread) => ({ ...thread })),
    ];
  }

  inspectThread(threadId: string): LiveThreadInspection | undefined {
    const thread = this.#root?.id === threadId ? this.#root : this.#threads.get(threadId);
    if (thread === undefined) return undefined;
    return {
      thread: { ...thread },
      events: [...(this.#events.get(threadId) ?? [])],
    };
  }

  snapshot(): LiveCoordinatorSnapshot {
    return {
      coordinatorId: this.#coordinatorId,
      sequence: this.#sequence,
      threads: this.listThreads(),
    };
  }

  buildSessionSummary(): string {
    const childThreads = this.listThreads().filter((thread) => thread.path !== "/root");
    if (childThreads.length === 0) return "No delegated threads are active.";
    return [
      "Current delegated work:",
      ...childThreads.map((thread) => {
        const detail = thread.latestCommentary ?? thread.activity?.detail ?? thread.finalSummary;
        return `- ${thread.name}: ${thread.status} — ${thread.task}${detail === undefined ? "" : ` — ${detail}`}`;
      }),
    ].join("\n");
  }

  async messageThread(
    threadId: string,
    message: string,
    delivery: SubagentDelivery,
    ctx: ExtensionContext,
  ): Promise<LiveThreadSnapshot> {
    if (this.#runtime === undefined) throw new Error("Subagent runtime is unavailable");
    const state = await this.#runtime.message({ sessionId: threadId, message, delivery }, ctx);
    this.#recordState(state);
    return this.#threads.get(threadId)!;
  }

  async interruptThread(threadId: string): Promise<LiveThreadSnapshot> {
    if (this.#runtime === undefined) throw new Error("Subagent runtime is unavailable");
    const state = await this.#runtime.interrupt({ sessionId: threadId });
    this.#recordState(state);
    return this.#threads.get(threadId)!;
  }

  subscribe(listener: (event: LiveCoordinatorEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribeRuntime) unsubscribe();
    this.#unsubscribeRuntime = [];
    this.#runtime = undefined;
    for (const buffer of this.#commentaryBuffers.values()) clearTimeout(buffer.timer);
    this.#commentaryBuffers.clear();
    this.#listeners.clear();
    this.#threads.clear();
    this.#events.clear();
    this.#root = undefined;
    this.#sequence = 0;
    this.#coordinatorId = crypto.randomUUID();
  }

  #recordState(state: RuntimeSubagent): void {
    const previous = this.#threads.get(state.sessionId);
    const next = snapshotFromState(state);
    this.#threads.set(state.sessionId, next);
    if (previous === undefined) {
      this.#emit("thread.started", state.sessionId, { thread: next }, state.updatedAt);
      return;
    }
    if (previous.status !== next.status) {
      this.#emit("thread.status", state.sessionId, { status: next.status }, state.updatedAt);
    }
    if (next.activity !== undefined && previous.activity?.updatedAt !== next.activity.updatedAt) {
      this.#emit("thread.activity", state.sessionId, { activity: next.activity }, state.updatedAt);
    }
    if (
      (next.status === "completed" || next.status === "failed" || next.status === "cancelled") &&
      previous.status !== next.status
    ) {
      this.#emit(
        "thread.completed",
        state.sessionId,
        { status: next.status, summary: next.finalSummary },
        state.updatedAt,
      );
    }
  }

  #recordChildEvent(sessionId: string, event: SubagentChildIpcEvent): void {
    const commentary = readCommentaryDelta(event);
    if (commentary === undefined) return;
    const buffered = this.#commentaryBuffers.get(sessionId);
    if (buffered !== undefined) {
      buffered.text += commentary;
      return;
    }
    const timer = setTimeout(() => {
      this.#flushCommentary(sessionId);
    }, COMMENTARY_BATCH_MS);
    timer.unref?.();
    this.#commentaryBuffers.set(sessionId, { text: commentary, timer });
  }

  #flushCommentary(sessionId: string): void {
    const buffered = this.#commentaryBuffers.get(sessionId);
    if (buffered === undefined) return;
    this.#commentaryBuffers.delete(sessionId);
    const commentary = buffered.text;
    const thread = this.#threads.get(sessionId);
    if (thread !== undefined) {
      this.#threads.set(sessionId, {
        ...thread,
        latestCommentary: commentary,
        updatedAt: Date.now(),
      });
    }
    this.#emit("thread.commentary", sessionId, { text: commentary });
  }

  #deliverParentMessage(sessionId: string, message: SubagentParentMessage): void {
    const thread = this.#threads.get(sessionId);
    if (thread !== undefined) {
      this.#threads.set(sessionId, {
        ...thread,
        latestCommentary: message.message,
        updatedAt: message.createdAt,
      });
    }
    this.#pi.sendMessage(
      {
        customType: SUBAGENT_PARENT_MESSAGE_TYPE,
        content: message.message,
        display: true,
        details: {
          sessionId,
          name: thread?.name ?? sessionId,
          kind: message.kind,
          createdAt: message.createdAt,
        },
      },
      { triggerTurn: true, deliverAs: message.delivery },
    );
    this.#emit(
      "thread.message",
      sessionId,
      { kind: message.kind, message: message.message, delivery: message.delivery },
      message.createdAt,
    );
  }

  #emit(
    type: LiveCoordinatorEvent["type"],
    threadId: string,
    data: Record<string, unknown>,
    timestamp = Date.now(),
  ): void {
    const event: LiveCoordinatorEvent = {
      coordinatorId: this.#coordinatorId,
      sequence: ++this.#sequence,
      type,
      threadId,
      timestamp,
      data,
    };
    const events = [...(this.#events.get(threadId) ?? []), event];
    this.#events.set(threadId, events.slice(-MAX_THREAD_EVENTS));
    for (const listener of this.#listeners) listener(event);
  }
}

const coordinatorByPi = new WeakMap<ExtensionAPI, LiveSessionCoordinator>();

export function getLiveSessionCoordinator(pi: ExtensionAPI): LiveSessionCoordinator {
  const existing = coordinatorByPi.get(pi);
  if (existing !== undefined) return existing;
  const coordinator = new LiveSessionCoordinator(pi);
  coordinatorByPi.set(pi, coordinator);
  return coordinator;
}
