import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentSessionEvent,
  AgentSessionRuntime,
  ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";
import { createRemoteUiContext as createRemoteUiContextForSession } from "./ui-context.js";
import type { AuthSession } from "../auth.js";
import { RemoteError } from "../errors.js";
import { LoadedRuntimeRegistry } from "../loaded-runtime-registry.js";
import { flushPersistedSessionManagerToDisk } from "../session-manager-storage.js";
import { SessionCatalog } from "../session-catalog.js";
import type {
  CommandAcceptedResponse,
  CommandKind,
  ExtensionUiRequestEventPayload,
  RemoteExtensionMetadata,
  SessionSnapshot,
} from "../schemas.js";
import { appEventsStreamId, InMemoryDurableStreamStore } from "../streams.js";
import type { RemoteRuntimeFactory } from "../runtime-factory.js";
import {
  ALLOWED_THINKING_LEVELS,
  acceptSessionCommandWithStreams,
  appendExtensionUiRequestEvent,
  createSessionRecord,
  dispatchRuntimeCommandWithStreams,
  emitSessionSummaryUpdatedEvent,
  ensurePromptPreflight,
  getRequiredSessionRecord,
  getRuntimeSessionFromRecord,
  handleRegistrySessionEvent,
  installRemoteExtensionEventMirror,
  isApiModel,
  parseModelRefStrict,
  parseResourceLoaderExtensionMetadata,
  parseRuntimeExtensionMetadata,
  parseThinkingLevelFromAllowedSet,
  pruneExpiredSessionPresence,
  requireRuntimeSessionFromRecord,
  syncSessionRecordFromRuntime,
  toSessionSnapshotRecord,
  type AcceptCommandHooks,
  type AcceptedSessionCommand,
  type SessionRecord,
  type SessionRegistryOptions,
  type ThinkingLevel,
} from "./deps.js";
import type { ClientCapabilities, ConnectionCapabilitiesResponse } from "../schemas.js";
import {
  readConnectionCapabilitiesForSessions,
  setConnectionCapabilitiesForSessions,
} from "./connection-capabilities.js";

export abstract class SessionRegistryBase {
  protected readonly loadedRuntimes = new LoadedRuntimeRegistry();
  protected readonly connectionCapabilities = new Map<
    string,
    {
      clientId: string;
      keyId: string;
      capabilities: ClientCapabilities;
      updatedAt: number;
    }
  >();
  protected readonly streams: InMemoryDurableStreamStore;
  protected readonly runtimeFactory: RemoteRuntimeFactory;
  protected readonly catalog: SessionCatalog;
  protected readonly presenceTtlMs: number;
  protected readonly runtimeIdleTtlMs: number | undefined;
  protected readonly now: () => number;
  protected sessionCreationQueue: Promise<void> = Promise.resolve();

  constructor(options: SessionRegistryOptions) {
    this.streams = options.streams;
    this.runtimeFactory = options.runtimeFactory;
    this.catalog =
      options.catalog ??
      new SessionCatalog({
        rootDir: join(process.cwd(), ".pi", "remote-sessions"),
      });
    this.presenceTtlMs = options.presenceTtlMs ?? 120_000;
    this.runtimeIdleTtlMs = options.runtimeIdleTtlMs;
    this.now = options.now ?? (() => Date.now());
  }

  protected handleSessionEvent(sessionId: string, event: AgentSessionEvent): void {
    handleRegistrySessionEvent({
      sessionId,
      event,
      sessions: this.getLoadedSessions(),
      streams: this.streams,
      now: this.now(),
      createRunId: () => randomUUID(),
      syncFromRuntime: (record, options) => {
        this.syncFromRuntime(record, options);
      },
      emitSessionSummaryUpdated: (record, ts) => {
        this.emitSessionSummaryUpdated(record, ts);
      },
    });
  }

  protected acceptCommand<TPayload>(
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    kind: CommandKind,
    payload: TPayload & { requestId?: string },
    hooksOrOnAccepted:
      | AcceptCommandHooks
      | ((accepted: AcceptedSessionCommand) => Promise<void> | void),
  ): Promise<CommandAcceptedResponse> {
    return acceptSessionCommandWithStreams({
      streams: this.streams,
      record,
      client,
      connectionId,
      kind,
      payload,
      hooksOrOnAccepted,
      createCommandId: () => randomUUID(),
      now: this.now,
      touchPresence: (targetSessionId, targetClient, targetConnectionId) => {
        this.touchPresence(targetSessionId, targetClient, targetConnectionId);
      },
      syncFromRuntime: (targetRecord, options) => {
        this.syncFromRuntime(targetRecord, options);
      },
    });
  }

  protected createRemoteUiContext(record: SessionRecord): ExtensionUIContext {
    return createRemoteUiContextForSession({
      record,
      now: this.now,
      publishUiEvent: (sessionRecord, payload) => {
        this.publishUiEvent(sessionRecord, payload);
      },
    });
  }

  protected publishUiEvent(record: SessionRecord, payload: ExtensionUiRequestEventPayload): void {
    appendExtensionUiRequestEvent({
      streams: this.streams,
      record,
      payload,
      ts: this.now(),
    });
  }

  protected ensurePromptPreflight(
    session: NonNullable<AgentSessionRuntime["session"]>,
  ): Promise<void> {
    return ensurePromptPreflight({
      session,
      isApiModel,
    });
  }

  protected dispatchRuntimeCommand(
    record: SessionRecord,
    command: AcceptedSessionCommand,
    operation: () => Promise<void>,
  ): void {
    dispatchRuntimeCommandWithStreams({
      streams: this.streams,
      record,
      command,
      operation,
      syncFromRuntime: (sessionRecord, options) => {
        this.syncFromRuntime(sessionRecord, options);
      },
      getRuntimeSession: (sessionRecord) => this.getRuntimeSession(sessionRecord),
      now: this.now,
      emitSessionSummaryUpdated: (sessionRecord, ts) => {
        this.emitSessionSummaryUpdated(sessionRecord, ts);
      },
    });
  }

  protected isRegisteredExtensionCommand(
    session: NonNullable<AgentSessionRuntime["session"]>,
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

  protected emitSessionSummaryUpdated(record: SessionRecord, ts: number): void {
    emitSessionSummaryUpdatedEvent({
      streams: this.streams,
      record,
      ts,
    });
  }

  protected syncFromRuntime(
    record: SessionRecord,
    options?: {
      now?: number;
      updateTimestamp?: boolean;
      syncResources?: boolean;
    },
  ): void {
    syncSessionRecordFromRuntime({
      record,
      now: this.now,
      options,
      getRuntimeSession: (sessionRecord) => this.getRuntimeSession(sessionRecord),
    });
  }

  protected getRuntimeSession(record: SessionRecord): AgentSessionRuntime["session"] | undefined {
    return getRuntimeSessionFromRecord(record);
  }

  protected readRuntimeExtensionMetadata(runtime: AgentSessionRuntime): RemoteExtensionMetadata[] {
    const runtimeMetadata = parseRuntimeExtensionMetadata(
      (runtime as AgentSessionRuntime & { remoteExtensionMetadata?: unknown })
        .remoteExtensionMetadata,
    );
    if (runtimeMetadata.length > 0) {
      return runtimeMetadata;
    }

    return this.readResourceLoaderExtensionMetadata(runtime);
  }

  protected readResourceLoaderExtensionMetadata(
    runtime: AgentSessionRuntime,
  ): RemoteExtensionMetadata[] {
    const session = runtime.session;
    if (session === undefined || session === null || typeof session !== "object") {
      return [];
    }

    const resourceLoader = session.resourceLoader;
    if (
      resourceLoader === undefined ||
      resourceLoader === null ||
      typeof resourceLoader !== "object"
    ) {
      return [];
    }

    const loaded = resourceLoader.getExtensions();
    if (loaded === undefined || loaded === null || typeof loaded !== "object") {
      return [];
    }

    return parseResourceLoaderExtensionMetadata(loaded.extensions);
  }

  protected requireRuntimeSession(record: SessionRecord): AgentSessionRuntime["session"] {
    return requireRuntimeSessionFromRecord(record);
  }

  protected parseModelRef(model: string): { provider: string; modelId: string } | null {
    return parseModelRefStrict(model);
  }

  protected parseThinkingLevel(level: string | undefined): ThinkingLevel | undefined {
    return parseThinkingLevelFromAllowedSet(ALLOWED_THINKING_LEVELS, level);
  }

  protected getRequired(sessionId: string): SessionRecord {
    return getRequiredSessionRecord(this.getLoadedSessions(), sessionId);
  }

  protected getLoadedSessions(): Map<string, SessionRecord> {
    return this.loadedRuntimes.asMap();
  }

  protected ensureLoaded(sessionId: string): Promise<SessionRecord> {
    const loaded = this.loadedRuntimes.get(sessionId);
    if (loaded) {
      return Promise.resolve(loaded);
    }

    const catalogRecord = this.catalog.get(sessionId);
    if (!catalogRecord) {
      throw new RemoteError("Session not found", 404);
    }

    if (!this.runtimeFactory.load) {
      throw new RemoteError("Session runtime is unavailable", 409);
    }

    return this.loadedRuntimes.load(sessionId, async () => {
      const runtime = await this.runtimeFactory.load!({
        sessionId: catalogRecord.sessionId,
        sessionPath: catalogRecord.sessionPath,
        cwd: catalogRecord.cwd,
      });
      try {
        const runtimeSessionId = runtime.session?.sessionManager.getSessionId();
        if (
          typeof runtimeSessionId === "string" &&
          runtimeSessionId.length > 0 &&
          runtimeSessionId !== catalogRecord.sessionId
        ) {
          throw new RemoteError("Loaded session runtime did not match requested session", 500);
        }
        const loadedAt = this.now();
        const record = createSessionRecord({
          sessionId: catalogRecord.sessionId,
          sessionName: catalogRecord.sessionName,
          persistence: catalogRecord.persistence,
          createdAt: catalogRecord.createdAt,
          updatedAt: catalogRecord.modifiedAt,
          runtime,
          lastAppStreamOffsetSeenByServer: this.streams.getHeadOffset(appEventsStreamId()),
          readRuntimeExtensionMetadata: (targetRuntime) =>
            this.readRuntimeExtensionMetadata(targetRuntime),
        });
        await this.initializeRuntimeRecord(record, {
          initializedAt: loadedAt,
          syncSessionNameToRuntime: false,
          flushPersistedSessionManager: false,
        });
        this.loadedRuntimes.set(record);
        this.emitSessionSummaryUpdated(record, loadedAt);
        return record;
      } catch (error) {
        await runtime.dispose();
        throw error;
      }
    });
  }

  protected pruneExpiredPresence(record: SessionRecord, now: number): void {
    pruneExpiredSessionPresence(record, now, this.presenceTtlMs);
  }

  protected toSessionSnapshot(record: SessionRecord): SessionSnapshot {
    return toSessionSnapshotRecord(record, (streamId) => this.streams.getHeadOffset(streamId));
  }

  protected async initializeRuntimeRecord(
    record: SessionRecord,
    input: {
      initializedAt: number;
      syncSessionNameToRuntime: boolean;
      flushPersistedSessionManager: boolean;
    },
  ): Promise<void> {
    const session = this.getRuntimeSession(record);
    if (!session) {
      return;
    }

    installRemoteExtensionEventMirror({
      runner: session.extensionRunner,
      streams: this.streams,
      record,
      now: this.now,
    });

    await session.bindExtensions({
      uiContext: this.createRemoteUiContext(record),
    });
    if (input.syncSessionNameToRuntime && typeof session.setSessionName === "function") {
      session.setSessionName(record.sessionName);
    }
    if (input.flushPersistedSessionManager) {
      flushPersistedSessionManagerToDisk(session.sessionManager);
    }
    this.syncFromRuntime(record, { now: input.initializedAt, updateTimestamp: false });
    this.catalog.registerPersistedRuntimeRecord(record);
    record.runtimeSubscription = session.subscribe((event) => {
      this.handleSessionEvent(record.sessionId, event);
    });
  }

  setConnectionCapabilities(
    connectionId: string,
    capabilities: ClientCapabilities,
    client: AuthSession,
  ): ConnectionCapabilitiesResponse {
    return setConnectionCapabilitiesForSessions({
      connectionCapabilities: this.connectionCapabilities,
      sessions: this.getLoadedSessions(),
      connectionId,
      capabilities,
      client,
      now: this.now,
    });
  }

  protected readConnectionCapabilities(
    clientId: string,
    connectionId: string,
  ): ClientCapabilities | undefined {
    return readConnectionCapabilitiesForSessions(
      this.connectionCapabilities,
      clientId,
      connectionId,
    );
  }

  abstract touchPresence(sessionId: string, client: AuthSession, connectionId?: string): void;
}
