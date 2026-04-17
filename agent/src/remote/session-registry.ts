import { randomUUID } from "node:crypto";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent, AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import { RemoteError } from "./errors.js";
import type { AuthSession } from "./auth.js";
import type {
  AppSnapshot,
  CommandAcceptedResponse,
  CommandKind,
  CreateSessionRequest,
  CreateSessionResponse,
  DraftUpdateRequest,
  FollowUpCommandRequest,
  InterruptCommandRequest,
  ModelUpdateRequest,
  Presence,
  PromptCommandRequest,
  SessionNameUpdateRequest,
  SteerCommandRequest,
  SessionStatus,
  SessionSnapshot,
  SessionSummary,
} from "./schemas.js";
import { InMemoryDurableStreamStore, appEventsStreamId, sessionEventsStreamId } from "./streams.js";
import type { RemoteRuntimeFactory } from "./runtime-factory.js";

interface SessionRecord {
  sessionId: string;
  sessionName: string;
  status: SessionStatus;
  model: string;
  thinkingLevel: string;
  activeTools: string[];
  draft: {
    text: string;
    attachments: string[];
    revision: number;
    updatedAt: number;
    updatedByClientId: string | null;
  };
  transcript: unknown[];
  queue: {
    depth: number;
    nextSequence: number;
  };
  retry: {
    status: string;
  };
  compaction: {
    status: string;
  };
  activeRun: SessionSnapshot["activeRun"];
  streamingState: string;
  pendingToolCalls: unknown[];
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  lastAppStreamOffsetSeenByServer: string;
  presence: Map<string, Presence>;
  runtime: AgentSessionRuntime;
  runtimeSubscription?: () => void;
  commandAcceptanceQueue: Promise<void>;
  runtimeDispatchQueue: Promise<void>;
  runtimeUndispatchedCommandCount: number;
  hasLocalCommandError: boolean;
}

interface AcceptedSessionCommand {
  commandId: string;
  sessionId: string;
  clientId: string;
  requestId: string | null;
  kind: CommandKind;
  payload: unknown;
  acceptedAt: number;
  sequence: number;
}

interface AcceptCommandHooks {
  beforeAccepted?: (accepted: AcceptedSessionCommand) => Promise<void> | void;
  onAccepted?: (accepted: AcceptedSessionCommand) => Promise<void> | void;
}

interface SessionRegistryOptions {
  streams: InMemoryDurableStreamStore;
  runtimeFactory: RemoteRuntimeFactory;
  presenceTtlMs?: number;
  now?: () => number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly streams: InMemoryDurableStreamStore;
  private readonly runtimeFactory: RemoteRuntimeFactory;
  private readonly presenceTtlMs: number;
  private readonly now: () => number;
  private sessionCreationQueue: Promise<void> = Promise.resolve();
  private readonly allowedThinkingLevels = new Set<ThinkingLevel>([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);

  constructor(options: SessionRegistryOptions) {
    this.streams = options.streams;
    this.runtimeFactory = options.runtimeFactory;
    this.presenceTtlMs = options.presenceTtlMs ?? 120_000;
    this.now = options.now ?? (() => Date.now());
    this.streams.ensureStream(appEventsStreamId());
  }

  async createSession(
    input: CreateSessionRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CreateSessionResponse> {
    return this.enqueueSessionCreation(async () => {
      if (this.sessions.size >= 1) {
        throw new RemoteError("Milestone 1 supports only one in-memory session", 409);
      }

      const createdAt = this.now();
      const sessionId = randomUUID();
      const runtime = await this.runtimeFactory.create();

      try {
        const record: SessionRecord = {
          sessionId,
          sessionName: input.sessionName ?? `Session ${this.sessions.size + 1}`,
          status: "idle",
          model: "pi-remote-faux/pi-remote-faux-1",
          thinkingLevel: "medium",
          activeTools: ["read", "bash", "edit", "write"],
          draft: {
            text: "",
            attachments: [],
            revision: 0,
            updatedAt: createdAt,
            updatedByClientId: null,
          },
          transcript: [],
          queue: {
            depth: 0,
            nextSequence: 1,
          },
          retry: {
            status: "idle",
          },
          compaction: {
            status: "idle",
          },
          activeRun: null,
          streamingState: "idle",
          pendingToolCalls: [],
          errorMessage: null,
          createdAt,
          updatedAt: createdAt,
          lastAppStreamOffsetSeenByServer: this.streams.getHeadOffset(appEventsStreamId()),
          presence: new Map(),
          runtime,
          commandAcceptanceQueue: Promise.resolve(),
          runtimeDispatchQueue: Promise.resolve(),
          runtimeUndispatchedCommandCount: 0,
          hasLocalCommandError: false,
        };

        const session = this.getRuntimeSession(record);
        if (session) {
          await session.bindExtensions({});
          this.syncFromRuntime(record, { now: createdAt, updateTimestamp: false });
          record.runtimeSubscription = session.subscribe((event) => {
            this.handleSessionEvent(record.sessionId, event);
          });
        }

        this.sessions.set(sessionId, record);
        this.streams.ensureStream(sessionEventsStreamId(sessionId));
        const event = this.streams.append(appEventsStreamId(), {
          sessionId,
          kind: "session_created",
          payload: {
            sessionId,
            sessionName: record.sessionName,
            status: record.status,
          },
          ts: createdAt,
        });
        record.lastAppStreamOffsetSeenByServer = event.streamOffset;
        this.touchPresence(sessionId, client, connectionId);

        return {
          sessionId,
          sessionName: record.sessionName,
          status: record.status,
        };
      } catch (error) {
        this.sessions.delete(sessionId);
        await runtime.dispose();
        throw error;
      }
    });
  }

  private enqueueSessionCreation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.sessionCreationQueue.then(operation);
    this.sessionCreationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  getSessionSnapshot(
    sessionId: string,
    client: AuthSession,
    connectionId?: string,
  ): SessionSnapshot {
    const record = this.getRequired(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    this.syncFromRuntime(record, { updateTimestamp: false });
    return this.toSessionSnapshot(record);
  }

  getAppSnapshot(client: AuthSession): AppSnapshot {
    return {
      serverInfo: {
        name: "pi-remote",
        version: "0.1.0",
        now: this.now(),
      },
      currentClientAuthInfo: {
        clientId: client.clientId,
        keyId: client.keyId,
        tokenExpiresAt: client.expiresAt,
      },
      sessionSummaries: this.listSessionSummaries(),
      recentNotices: [],
      defaultAttachSessionId: this.sessions.values().next().value?.sessionId,
    };
  }

  listSessionSummaries(): SessionSummary[] {
    return [...this.sessions.values()].map((record) => {
      this.syncFromRuntime(record, { updateTimestamp: false });
      return {
        sessionId: record.sessionId,
        sessionName: record.sessionName,
        status: record.status,
        draftRevision: record.draft.revision,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastSessionStreamOffset: this.streams.getHeadOffset(
          sessionEventsStreamId(record.sessionId),
        ),
      };
    });
  }

  async prompt(
    sessionId: string,
    input: PromptCommandRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
    const session = this.requireRuntimeSession(record);
    return this.acceptCommand(record, client, connectionId, "prompt", input, {
      beforeAccepted: async () => {
        if (this.isRegisteredExtensionCommand(session, input.text)) {
          return;
        }
        if (session.isStreaming) {
          return;
        }
        await this.ensurePromptPreflight(session);
      },
      onAccepted: (accepted) => {
        this.dispatchRuntimeCommand(record, accepted, async () => {
          const images = this.toImageAttachments(input.attachments);
          const options = session.isStreaming
            ? ({ streamingBehavior: "followUp", ...(images ? { images } : {}) } as const)
            : images
              ? { images }
              : undefined;
          await session.prompt(input.text, options);
        });
      },
    });
  }

  async steer(
    sessionId: string,
    input: SteerCommandRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
    this.requireRuntimeSession(record);
    return this.acceptCommand(record, client, connectionId, "steer", input, (accepted) => {
      this.dispatchRuntimeCommand(record, accepted, async () => {
        const session = this.requireRuntimeSession(record);
        await session.steer(input.text, this.toImageAttachments(input.attachments));
      });
    });
  }

  async followUp(
    sessionId: string,
    input: FollowUpCommandRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
    this.requireRuntimeSession(record);
    return this.acceptCommand(record, client, connectionId, "follow-up", input, (accepted) => {
      this.dispatchRuntimeCommand(record, accepted, async () => {
        const session = this.requireRuntimeSession(record);
        await session.followUp(input.text, this.toImageAttachments(input.attachments));
      });
    });
  }

  async interrupt(
    sessionId: string,
    input: InterruptCommandRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
    this.requireRuntimeSession(record);
    return this.acceptCommand(record, client, connectionId, "interrupt", input, (accepted) => {
      this.dispatchRuntimeCommand(record, accepted, async () => {
        const session = this.requireRuntimeSession(record);
        session.clearQueue();
        await session.abort();
      });
    });
  }

  async updateDraft(
    sessionId: string,
    input: DraftUpdateRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
    return this.acceptCommand(record, client, connectionId, "draft", input, (accepted) => {
      const updatedAt = this.now();
      record.draft.text = input.text;
      record.draft.attachments = [...(input.attachments ?? [])];
      record.draft.revision += 1;
      record.draft.updatedAt = updatedAt;
      record.draft.updatedByClientId = client.clientId;
      record.updatedAt = updatedAt;
      this.streams.append(sessionEventsStreamId(record.sessionId), {
        sessionId: record.sessionId,
        kind: "draft_updated",
        payload: {
          commandId: accepted.commandId,
          sequence: accepted.sequence,
          draft: {
            text: record.draft.text,
            attachments: [...record.draft.attachments],
            revision: record.draft.revision,
            updatedAt: record.draft.updatedAt,
            updatedByClientId: record.draft.updatedByClientId,
          },
        },
        ts: updatedAt,
      });
      this.emitSessionSummaryUpdated(record, updatedAt);
    });
  }

  async updateModel(
    sessionId: string,
    input: ModelUpdateRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
    const session = this.requireRuntimeSession(record);
    const parsed = this.parseModelRef(input.model);
    if (!parsed) {
      throw new RemoteError("Model must use provider/model format", 400);
    }
    const model = session.modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model && input.model !== record.model) {
      throw new RemoteError("Model not found", 400);
    }
    const thinkingLevel = this.parseThinkingLevel(input.thinkingLevel);

    return this.acceptCommand(record, client, connectionId, "model", input, {
      beforeAccepted: async () => {
        if (model) {
          await session.setModel(model);
        } else {
          record.model = input.model;
        }
        if (thinkingLevel) {
          session.setThinkingLevel(thinkingLevel);
          record.thinkingLevel = thinkingLevel;
        }
      },
      onAccepted: (accepted) => {
        this.syncFromRuntime(record, { updateTimestamp: false });
        record.updatedAt = this.now();
        this.streams.append(sessionEventsStreamId(record.sessionId), {
          sessionId: record.sessionId,
          kind: "session_state_patch",
          payload: {
            commandId: accepted.commandId,
            sequence: accepted.sequence,
            patch: {
              model: record.model,
              thinkingLevel: record.thinkingLevel,
            },
          },
          ts: record.updatedAt,
        });
        this.emitSessionSummaryUpdated(record, record.updatedAt);
      },
    });
  }

  async updateSessionName(
    sessionId: string,
    input: SessionNameUpdateRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
    const session = this.getRuntimeSession(record);
    return this.acceptCommand(record, client, connectionId, "session-name", input, {
      onAccepted: (accepted) => {
        const updatedAt = this.now();
        record.sessionName = input.sessionName;
        session?.setSessionName(input.sessionName);
        record.updatedAt = updatedAt;
        this.streams.append(sessionEventsStreamId(record.sessionId), {
          sessionId: record.sessionId,
          kind: "session_state_patch",
          payload: {
            commandId: accepted.commandId,
            sequence: accepted.sequence,
            patch: {
              sessionName: record.sessionName,
            },
          },
          ts: updatedAt,
        });
        this.emitSessionSummaryUpdated(record, updatedAt);
      },
    });
  }

  touchPresence(sessionId: string, client: AuthSession, connectionId?: string): void {
    const record = this.getRequired(sessionId);
    const now = this.now();
    this.pruneExpiredPresence(record, now);
    const resolvedConnectionId = connectionId ?? randomUUID();
    const presenceKey = resolvedConnectionId;
    const existing = record.presence.get(presenceKey);
    if (existing) {
      existing.lastSeenAt = now;
      existing.connectionId = resolvedConnectionId;
      existing.lastSeenAppOffset = this.streams.getHeadOffset(appEventsStreamId());
      existing.lastSeenSessionOffset = this.streams.getHeadOffset(sessionEventsStreamId(sessionId));
      return;
    }

    record.presence.set(presenceKey, {
      clientId: client.clientId,
      connectionId: resolvedConnectionId,
      connectedAt: now,
      lastSeenAt: now,
      lastSeenAppOffset: this.streams.getHeadOffset(appEventsStreamId()),
      lastSeenSessionOffset: this.streams.getHeadOffset(sessionEventsStreamId(sessionId)),
    });
  }

  detachPresence(sessionId: string, connectionId: string): void {
    const record = this.getRequired(sessionId);
    record.presence.delete(connectionId);
  }

  async dispose(): Promise<void> {
    for (const record of this.sessions.values()) {
      record.runtimeSubscription?.();
      await record.runtime.dispose();
    }
    this.sessions.clear();
    await this.runtimeFactory.dispose();
  }

  private handleSessionEvent(sessionId: string, event: AgentSessionEvent): void {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return;
    }

    const now = this.now();
    if (event.type === "agent_start" && !record.activeRun) {
      record.activeRun = {
        runId: randomUUID(),
        status: "running",
        triggeringCommandId: "server",
        startedAt: now,
        updatedAt: now,
        queueDepth: record.queue.depth,
      };
    }
    if (event.type === "agent_end") {
      record.activeRun = null;
    }

    this.syncFromRuntime(record, { now, updateTimestamp: true });
    this.streams.append(sessionEventsStreamId(record.sessionId), {
      sessionId: record.sessionId,
      kind: "agent_session_event",
      payload: event,
      ts: now,
    });
    this.emitSessionSummaryUpdated(record, now);
  }

  private async acceptCommand<TPayload>(
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    kind: CommandKind,
    payload: TPayload & { requestId?: string },
    hooksOrOnAccepted:
      | AcceptCommandHooks
      | ((accepted: AcceptedSessionCommand) => Promise<void> | void),
  ): Promise<CommandAcceptedResponse> {
    const hooks: AcceptCommandHooks =
      typeof hooksOrOnAccepted === "function"
        ? { onAccepted: hooksOrOnAccepted }
        : hooksOrOnAccepted;

    return this.enqueueCommandAcceptance(record, async () => {
      this.touchPresence(record.sessionId, client, connectionId);
      const acceptedAt = this.now();
      const accepted: AcceptedSessionCommand = {
        commandId: randomUUID(),
        sessionId: record.sessionId,
        clientId: client.clientId,
        requestId: payload.requestId ?? null,
        kind,
        payload,
        acceptedAt,
        sequence: record.queue.nextSequence,
      };

      await hooks.beforeAccepted?.(accepted);

      record.queue.nextSequence += 1;
      record.updatedAt = acceptedAt;

      this.streams.append(sessionEventsStreamId(record.sessionId), {
        sessionId: record.sessionId,
        kind: "command_accepted",
        payload: accepted,
        ts: acceptedAt,
      });

      await hooks.onAccepted?.(accepted);
      this.syncFromRuntime(record, { now: acceptedAt, updateTimestamp: false });
      return {
        commandId: accepted.commandId,
        sessionId: accepted.sessionId,
        kind: accepted.kind,
        sequence: accepted.sequence,
        acceptedAt: accepted.acceptedAt,
      };
    });
  }

  private toImageAttachments(attachments: string[] | undefined): ImageContent[] | undefined {
    if (!attachments || attachments.length === 0) {
      return undefined;
    }

    return attachments.map((attachment) => {
      const matched = /^data:([^;,]+);base64,(.+)$/.exec(attachment);
      if (matched) {
        return {
          type: "image",
          mimeType: matched[1] ?? "application/octet-stream",
          data: matched[2] ?? "",
        };
      }

      return {
        type: "image",
        mimeType: "application/octet-stream",
        data: attachment,
      };
    });
  }

  private async ensurePromptPreflight(
    session: NonNullable<ReturnType<SessionRegistry["getRuntimeSession"]>>,
  ): Promise<void> {
    const model = session.model;
    if (!model) {
      throw new RemoteError("No model selected", 400);
    }

    const requestAuth = await session.modelRegistry.getApiKeyAndHeaders(model);
    if (!requestAuth.ok) {
      throw new RemoteError(requestAuth.error, 400);
    }
    if (requestAuth.apiKey) {
      return;
    }
    if (session.modelRegistry.isUsingOAuth(model)) {
      throw new RemoteError(
        `Authentication failed for "${model.provider}". Credentials may have expired or network is unavailable. Run '/login ${model.provider}' to re-authenticate.`,
        400,
      );
    }

    throw new RemoteError(`No API key found for ${model.provider}`, 400);
  }

  private enqueueCommandAcceptance<T>(
    record: SessionRecord,
    operation: () => Promise<T>,
  ): Promise<T> {
    const pending = record.commandAcceptanceQueue.then(operation, operation);
    record.commandAcceptanceQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private dispatchRuntimeCommand(
    record: SessionRecord,
    command: AcceptedSessionCommand,
    operation: () => Promise<void>,
  ): void {
    record.runtimeUndispatchedCommandCount += 1;

    const dispatch = async (): Promise<void> => {
      let failed = false;
      if (record.runtimeUndispatchedCommandCount > 0) {
        record.runtimeUndispatchedCommandCount -= 1;
      }
      const startedAt = this.now();
      record.updatedAt = startedAt;
      record.hasLocalCommandError = false;
      if (!record.activeRun && command.kind === "prompt") {
        record.activeRun = {
          runId: randomUUID(),
          status: "running",
          triggeringCommandId: command.commandId,
          startedAt,
          updatedAt: startedAt,
          queueDepth: record.queue.depth,
        };
      }

      const completion = operation()
        .catch((error: unknown) => {
          failed = true;
          const message = error instanceof Error ? error.message : "Command execution failed";
          record.errorMessage = message;
          record.status = "error";
          record.hasLocalCommandError = true;
          record.updatedAt = this.now();
          this.streams.append(sessionEventsStreamId(record.sessionId), {
            sessionId: record.sessionId,
            kind: "extension_error",
            payload: {
              commandId: command.commandId,
              kind: command.kind,
              error: message,
            },
            ts: record.updatedAt,
          });
          this.emitSessionSummaryUpdated(record, record.updatedAt);
        })
        .finally(() => {
          if (!failed) {
            record.hasLocalCommandError = false;
          }
          this.syncFromRuntime(record, {
            updateTimestamp: !failed,
          });
        });

      if (command.kind === "prompt") {
        await this.waitForPromptDispatchStart(record, completion);
        return;
      }

      await completion;
    };

    const pending = record.runtimeDispatchQueue.then(dispatch, dispatch);
    record.runtimeDispatchQueue = pending.then(
      () => undefined,
      () => undefined,
    );
  }

  private async waitForPromptDispatchStart(
    record: SessionRecord,
    completion: Promise<void>,
  ): Promise<void> {
    while (true) {
      const session = this.getRuntimeSession(record);
      if (!session || session.isStreaming) {
        return;
      }

      const state = await Promise.race<"tick" | "done">([
        completion.then(() => "done" as const),
        new Promise<"tick">((resolve) => {
          setImmediate(() => resolve("tick"));
        }),
      ]);
      if (state === "done") {
        return;
      }
    }
  }

  private isRegisteredExtensionCommand(
    session: NonNullable<ReturnType<SessionRegistry["getRuntimeSession"]>>,
    text: string,
  ): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      return false;
    }

    const commandName = trimmed.slice(1).trimStart().split(/\s+/, 1)[0];
    if (!commandName) {
      return false;
    }

    return Boolean(session.extensionRunner?.getCommand(commandName));
  }

  private emitSessionSummaryUpdated(record: SessionRecord, ts: number): void {
    const event = this.streams.append(appEventsStreamId(), {
      sessionId: record.sessionId,
      kind: "session_summary_updated",
      payload: {
        sessionId: record.sessionId,
        sessionName: record.sessionName,
        status: record.status,
        draftRevision: record.draft.revision,
        updatedAt: record.updatedAt,
      },
      ts,
    });
    record.lastAppStreamOffsetSeenByServer = event.streamOffset;
  }

  private syncFromRuntime(
    record: SessionRecord,
    options?: {
      now?: number;
      updateTimestamp?: boolean;
    },
  ): void {
    const session = this.getRuntimeSession(record);
    if (!session) {
      return;
    }

    const now = options?.now ?? this.now();
    const updateTimestamp = options?.updateTimestamp ?? true;

    const model = session.model;
    if (model) {
      record.model = `${model.provider}/${model.id}`;
    }
    record.thinkingLevel = session.thinkingLevel;
    record.activeTools = [...session.getActiveToolNames()];
    record.transcript = [...session.messages];
    record.streamingState = session.isStreaming ? "streaming" : "idle";
    record.pendingToolCalls = [...session.state.pendingToolCalls.values()];
    const runtimeErrorMessage = session.state.errorMessage ?? null;
    if (runtimeErrorMessage) {
      record.errorMessage = runtimeErrorMessage;
      record.hasLocalCommandError = false;
    } else if (!record.hasLocalCommandError) {
      record.errorMessage = null;
    }
    record.retry.status = session.isRetrying ? "running" : "idle";
    record.compaction.status = session.isCompacting ? "running" : "idle";
    record.queue.depth =
      session.pendingMessageCount +
      (session.isStreaming ? 1 : 0) +
      record.runtimeUndispatchedCommandCount;
    record.status = this.deriveStatus(session, record.errorMessage);
    if (updateTimestamp) {
      record.updatedAt = now;
    }

    if (record.activeRun) {
      if (updateTimestamp) {
        record.activeRun.updatedAt = now;
      }
      record.activeRun.queueDepth = record.queue.depth;
      record.activeRun.status = record.status;
      if (!session.isStreaming && record.queue.depth === 0) {
        record.activeRun = null;
      }
    }
  }

  private deriveStatus(
    session: NonNullable<ReturnType<SessionRegistry["getRuntimeSession"]>>,
    errorMessage: string | null,
  ): SessionStatus {
    if (session.isCompacting) {
      return "compacting";
    }
    if (session.isRetrying) {
      return "retrying";
    }
    if (session.isStreaming) {
      return "running";
    }
    if (errorMessage) {
      return "error";
    }
    return "idle";
  }

  private getRuntimeSession(record: SessionRecord): AgentSessionRuntime["session"] | undefined {
    const runtime = record.runtime as AgentSessionRuntime & {
      session?: AgentSessionRuntime["session"];
    };
    if (!runtime.session) {
      return undefined;
    }
    return runtime.session;
  }

  private requireRuntimeSession(record: SessionRecord): AgentSessionRuntime["session"] {
    const session = this.getRuntimeSession(record);
    if (!session) {
      throw new RemoteError("Session runtime is unavailable", 409);
    }
    return session;
  }

  private parseModelRef(model: string): { provider: string; modelId: string } | null {
    const separator = model.indexOf("/");
    if (separator <= 0 || separator === model.length - 1) {
      return null;
    }
    return {
      provider: model.slice(0, separator),
      modelId: model.slice(separator + 1),
    };
  }

  private parseThinkingLevel(level: string | undefined): ThinkingLevel | undefined {
    if (!level) {
      return undefined;
    }
    if (this.allowedThinkingLevels.has(level as ThinkingLevel)) {
      return level as ThinkingLevel;
    }
    throw new RemoteError(
      `Invalid thinkingLevel. Expected one of: ${[...this.allowedThinkingLevels].join(", ")}`,
      400,
    );
  }

  private getRequired(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new RemoteError("Session not found", 404);
    }
    return record;
  }

  private pruneExpiredPresence(record: SessionRecord, now: number): void {
    for (const [presenceKey, presence] of record.presence.entries()) {
      if (now - presence.lastSeenAt > this.presenceTtlMs) {
        record.presence.delete(presenceKey);
      }
    }
  }

  private toSessionSnapshot(record: SessionRecord): SessionSnapshot {
    return {
      sessionId: record.sessionId,
      sessionName: record.sessionName,
      status: record.status,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
      activeTools: [...record.activeTools],
      draft: {
        text: record.draft.text,
        attachments: [...record.draft.attachments],
        revision: record.draft.revision,
        updatedAt: record.draft.updatedAt,
        updatedByClientId: record.draft.updatedByClientId,
      },
      draftRevision: record.draft.revision,
      transcript: [...record.transcript],
      queue: {
        depth: record.queue.depth,
        nextSequence: record.queue.nextSequence,
      },
      retry: {
        status: record.retry.status,
      },
      compaction: {
        status: record.compaction.status,
      },
      presence: [...record.presence.values()],
      activeRun: record.activeRun,
      lastSessionStreamOffset: this.streams.getHeadOffset(sessionEventsStreamId(record.sessionId)),
      lastAppStreamOffsetSeenByServer: record.lastAppStreamOffsetSeenByServer,
      streamingState: record.streamingState,
      pendingToolCalls: [...record.pendingToolCalls],
      errorMessage: record.errorMessage,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
