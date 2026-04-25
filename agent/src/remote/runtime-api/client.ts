import { hc } from "hono/client";
import type { createV1Routes } from "../routes.js";
import type {
  SessionToolsResponse,
  AppSnapshot,
  ClientCapabilities,
  ConnectionCapabilitiesResponse,
  CreateSessionResponse,
  SessionDeletedResponse,
  RemoteKvDeleteResponse,
  RemoteKvReadResponse,
  RemoteKvScope,
  RemoteKvWriteResponse,
  SessionSummary,
  SessionSnapshot,
  SettingsUpdateRequest,
  UiResponseRequest,
} from "../schemas.js";
import {
  AppSnapshotSchema,
  CreateSessionResponseSchema,
  RemoteKvDeleteResponseSchema,
  RemoteKvReadResponseSchema,
  RemoteKvWriteResponseSchema,
  SessionDeletedResponseSchema,
  SessionSummarySchema,
  SessionSnapshotSchema,
  SessionToolsResponseSchema,
} from "../schemas.js";
import { registerRemoteConnectionCapabilities } from "./capabilities.js";
import {
  clearRemoteSessionQueue,
  postActiveToolsUpdateCommand,
  postFollowUpCommand,
  postInterruptCommand,
  postModelUpdateCommand,
  postPromptCommand,
  postSettingsUpdateCommand,
  postSessionNameUpdateCommand,
  postSteerCommand,
  postUiResponseCommand,
} from "./session-commands.js";
import { assertType } from "../typebox.js";
import { requestRemoteAuthToken, type RemoteApiClientAuthOptions } from "./auth.js";
import {
  buildRemoteAuthHeaders,
  readRemoteConnectionIdHeader,
  resolveRemoteConnectionId,
} from "./internals.js";
import { readRemoteSessionEvents } from "./streams.js";
import {
  type ReadSessionEventsOptions,
  type StreamReadResult,
  toRemoteHttpError,
} from "./utils.js";

type RemoteV1Routes = ReturnType<typeof createV1Routes>;
type AuthFlowMode = "normal" | "forced";

export class RemoteApiClient {
  private readonly rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  private readonly auth: RemoteApiClientAuthOptions;
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clientCapabilities: ClientCapabilities | undefined;
  private token: string | undefined;
  private connectionId: string | undefined;
  private authTask: Promise<void> | undefined;
  private readonly sessionStreamCursors = new Map<string, string>();
  constructor(options: {
    origin: string;
    auth: RemoteApiClientAuthOptions;
    connectionId?: string;
    clientCapabilities?: ClientCapabilities;
    fetchImpl?: typeof fetch;
  }) {
    const origin = options.origin.replace(/\/$/, "");
    this.origin = origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rpcClient = hc<RemoteV1Routes>(`${origin}/v1`, { fetch: options.fetchImpl });
    this.auth = options.auth;
    this.connectionId = options.connectionId;
    this.clientCapabilities = options.clientCapabilities;
  }
  authenticate(): Promise<void> {
    return this.runAuthFlow("normal");
  }

  reauthenticate(): Promise<void> {
    return this.runAuthFlow("forced");
  }

  private runAuthFlow(mode: AuthFlowMode): Promise<void> {
    if (mode === "normal" && this.token !== undefined && this.token.length > 0) {
      return Promise.resolve();
    }
    if (this.authTask !== undefined) {
      return this.authTask;
    }

    const authTask = this.authenticateWithChallenge().finally(() => {
      if (this.authTask === authTask) {
        this.authTask = undefined;
      }
    });

    this.authTask = authTask;
    return authTask;
  }

  private async authenticateWithChallenge(): Promise<void> {
    this.token = await requestRemoteAuthToken({
      rpcAuthClient: this.rpcClient.auth,
      auth: this.auth,
      captureConnectionId: (response) => {
        this.captureConnectionId(response);
      },
    });
    if (this.clientCapabilities) {
      await this.registerConnectionCapabilities(this.clientCapabilities);
    }
  }

  async registerConnectionCapabilities(
    capabilities: ClientCapabilities,
  ): Promise<ConnectionCapabilitiesResponse> {
    return registerRemoteConnectionCapabilities({
      rpcClient: this.rpcClient,
      connectionId: this.resolveConnectionId(),
      headers: await this.getAuthHeaders(),
      capabilities,
      captureConnectionId: (response) => {
        this.captureConnectionId(response);
      },
    });
  }

  async getAppSnapshot(): Promise<AppSnapshot> {
    const response = await this.rpcClient.app.snapshot.$get(undefined, {
      headers: await this.getAuthHeaders(),
    });
    this.captureConnectionId(response);
    if (response.status !== 200) throw await toRemoteHttpError(response);
    const payload: unknown = await response.json();
    assertType(AppSnapshotSchema, payload);
    return payload;
  }

  async createSession(request?: {
    sessionName?: string;
    workspaceCwd?: string;
    persistence?: "persistent" | "ephemeral";
  }): Promise<CreateSessionResponse> {
    const body: {
      sessionName?: string;
      workspaceCwd?: string;
      persistence?: "persistent" | "ephemeral";
    } = {};
    if (request?.sessionName !== undefined && request.sessionName.length > 0) {
      body.sessionName = request.sessionName;
    }
    if (request?.workspaceCwd !== undefined && request.workspaceCwd.length > 0) {
      body.workspaceCwd = request.workspaceCwd;
    }
    if (request?.persistence) {
      body.persistence = request.persistence;
    }
    const response = await this.rpcClient.sessions.$post(
      { json: body },
      { headers: await this.getAuthHeaders() },
    );
    this.captureConnectionId(response);
    if (response.status === 201) {
      const payload: unknown = await response.json();
      assertType(CreateSessionResponseSchema, payload);
      return payload;
    }
    throw await toRemoteHttpError(response);
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const response = await this.rpcClient.sessions[":sessionId"].snapshot.$get(
      { param: { sessionId } },
      { headers: await this.getAuthHeaders() },
    );
    this.captureConnectionId(response);
    if (response.status !== 200) throw await toRemoteHttpError(response);
    const payload: unknown = await response.json();
    assertType(SessionSnapshotSchema, payload);
    return payload;
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary> {
    const response = await this.rpcClient.sessions[":sessionId"].summary.$get(
      { param: { sessionId } },
      { headers: await this.getAuthHeaders() },
    );
    this.captureConnectionId(response);
    if (response.status !== 200) throw await toRemoteHttpError(response);
    const payload: unknown = await response.json();
    assertType(SessionSummarySchema, payload);
    return payload;
  }

  async archiveSession(sessionId: string): Promise<SessionSummary> {
    const response = await this.rpcClient.sessions[":sessionId"].archive.$post(
      { param: { sessionId } },
      { headers: await this.getAuthHeaders() },
    );
    this.captureConnectionId(response);
    if (response.status !== 200) throw await toRemoteHttpError(response);
    const payload: unknown = await response.json();
    assertType(SessionSummarySchema, payload);
    return payload;
  }

  async restoreSession(sessionId: string): Promise<SessionSummary> {
    const response = await this.rpcClient.sessions[":sessionId"].restore.$post(
      { param: { sessionId } },
      { headers: await this.getAuthHeaders() },
    );
    this.captureConnectionId(response);
    if (response.status !== 200) throw await toRemoteHttpError(response);
    const payload: unknown = await response.json();
    assertType(SessionSummarySchema, payload);
    return payload;
  }

  async deleteSession(sessionId: string): Promise<SessionDeletedResponse> {
    const response = await this.rpcClient.sessions[":sessionId"].$delete(
      { param: { sessionId } },
      { headers: await this.getAuthHeaders() },
    );
    this.captureConnectionId(response);
    if (response.status !== 200) throw await toRemoteHttpError(response);
    const payload: unknown = await response.json();
    assertType(SessionDeletedResponseSchema, payload);
    return payload;
  }

  async getSessionTools(sessionId: string): Promise<SessionToolsResponse> {
    const response = await this.rpcClient.sessions[":sessionId"].tools.$get(
      { param: { sessionId } },
      { headers: await this.getAuthHeaders() },
    );
    this.captureConnectionId(response);
    if (response.status !== 200) throw await toRemoteHttpError(response);
    const payload: unknown = await response.json();
    assertType(SessionToolsResponseSchema, payload);
    return payload;
  }

  async reloadSession(sessionId: string): Promise<SessionSnapshot> {
    const response = await this.rpcClient.sessions[":sessionId"].reload.$post(
      { param: { sessionId } },
      { headers: await this.getAuthHeaders() },
    );
    this.captureConnectionId(response);
    if (response.status !== 200) throw await toRemoteHttpError(response);
    const payload: unknown = await response.json();
    assertType(SessionSnapshotSchema, payload);
    return payload;
  }

  prompt(sessionId: string, body: { text: string; attachments?: string[] }): Promise<void> {
    return postPromptCommand({
      rpcClient: this.rpcClient,
      sessionId,
      body,
      postSessionRoute: (request) => this.postSessionRoute(request),
    });
  }

  steer(sessionId: string, body: { text: string; attachments?: string[] }): Promise<void> {
    return postSteerCommand({
      rpcClient: this.rpcClient,
      sessionId,
      body,
      postSessionRoute: (request) => this.postSessionRoute(request),
    });
  }

  followUp(sessionId: string, body: { text: string; attachments?: string[] }): Promise<void> {
    return postFollowUpCommand({
      rpcClient: this.rpcClient,
      sessionId,
      body,
      postSessionRoute: (request) => this.postSessionRoute(request),
    });
  }

  interrupt(sessionId: string): Promise<void> {
    return postInterruptCommand({
      rpcClient: this.rpcClient,
      sessionId,
      postSessionRoute: (request) => this.postSessionRoute(request),
    });
  }

  updateModel(sessionId: string, body: { model: string; thinkingLevel?: string }): Promise<void> {
    return postModelUpdateCommand({
      rpcClient: this.rpcClient,
      sessionId,
      body,
      postSessionRoute: (request) => this.postSessionRoute(request),
    });
  }

  updateSessionName(sessionId: string, sessionName: string): Promise<void> {
    return postSessionNameUpdateCommand({
      rpcClient: this.rpcClient,
      sessionId,
      sessionName,
      postSessionRoute: (request) => this.postSessionRoute(request),
    });
  }

  renameSession(sessionId: string, sessionName: string): Promise<void> {
    return this.postRenameSessionRoute(sessionId, sessionName);
  }

  updateSettings(sessionId: string, body: SettingsUpdateRequest): Promise<void> {
    return postSettingsUpdateCommand({
      rpcClient: this.rpcClient,
      sessionId,
      body,
      postSessionRoute: (request) => this.postSessionRoute(request),
    });
  }

  updateActiveTools(sessionId: string, body: { toolNames: string[] }): Promise<void> {
    return postActiveToolsUpdateCommand({
      rpcClient: this.rpcClient,
      sessionId,
      body,
      postSessionRoute: (request) => this.postSessionRoute(request),
    });
  }

  postUiResponse(sessionId: string, response: UiResponseRequest): Promise<void> {
    return postUiResponseCommand({
      rpcClient: this.rpcClient,
      sessionId,
      response,
      postSessionRoute: (request) => this.postSessionRoute(request),
    });
  }

  async clearQueue(sessionId: string) {
    return clearRemoteSessionQueue({
      rpcClient: this.rpcClient,
      sessionId,
      headers: await this.getAuthHeaders(),
      captureConnectionId: (response) => {
        this.captureConnectionId(response);
      },
    });
  }

  async readKv(
    scope: RemoteKvScope,
    namespace: string,
    key: string,
  ): Promise<RemoteKvReadResponse> {
    const response = await this.fetchKv(
      `/${encodeURIComponent(scope)}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
      {
        method: "GET",
        headers: await this.getAuthHeaders(),
      },
    );
    if (response.status !== 200) {
      throw await toRemoteHttpError(response);
    }
    const payload: unknown = await response.json();
    assertType(RemoteKvReadResponseSchema, payload);
    return payload;
  }

  async writeKv(
    scope: RemoteKvScope,
    namespace: string,
    key: string,
    value: unknown,
  ): Promise<RemoteKvWriteResponse> {
    const response = await this.fetchKv(
      `/${encodeURIComponent(scope)}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        headers: {
          ...(await this.getAuthHeaders()),
          "content-type": "application/json",
        },
        body: JSON.stringify({ value }),
      },
    );
    if (response.status !== 200) {
      throw await toRemoteHttpError(response);
    }
    const payload: unknown = await response.json();
    assertType(RemoteKvWriteResponseSchema, payload);
    return payload;
  }

  async deleteKv(
    scope: RemoteKvScope,
    namespace: string,
    key: string,
  ): Promise<RemoteKvDeleteResponse> {
    const response = await this.fetchKv(
      `/${encodeURIComponent(scope)}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
        headers: await this.getAuthHeaders(),
      },
    );
    if (response.status !== 200) {
      throw await toRemoteHttpError(response);
    }
    const payload: unknown = await response.json();
    assertType(RemoteKvDeleteResponseSchema, payload);
    return payload;
  }

  async readSessionEvents(
    sessionId: string,
    offset: string,
    options?: ReadSessionEventsOptions,
  ): Promise<StreamReadResult> {
    return readRemoteSessionEvents({
      fetchImpl: this.fetchImpl,
      origin: this.origin,
      sessionId,
      offset,
      cursor: this.sessionStreamCursors.get(sessionId),
      headers: await this.getAuthHeaders(),
      signal: options?.signal,
      options,
      captureConnectionId: (response) => {
        this.captureConnectionId(response);
      },
      updateCursor: (cursor) => {
        this.updateSessionStreamCursor(sessionId, cursor);
      },
    });
  }

  private async postSessionRoute(
    request: (headers: Record<string, string>) => Promise<Response>,
  ): Promise<void> {
    const response = await request(await this.getAuthHeaders());
    this.captureConnectionId(response);
    if (!response.ok) throw await toRemoteHttpError(response);
  }

  private async postRenameSessionRoute(sessionId: string, sessionName: string): Promise<void> {
    const response = await this.fetchImpl(`${this.origin}/v1/sessions/${sessionId}/rename`, {
      method: "POST",
      headers: {
        ...(await this.getAuthHeaders()),
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionName }),
    });
    this.captureConnectionId(response);
    if (!response.ok) {
      throw await toRemoteHttpError(response);
    }
  }

  private updateSessionStreamCursor(sessionId: string, cursor: string | undefined): void {
    if (cursor !== undefined && cursor.length > 0) this.sessionStreamCursors.set(sessionId, cursor);
    else this.sessionStreamCursors.delete(sessionId);
  }

  private async fetchKv(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(`${this.origin}/v1/kv${path}`, init);
    this.captureConnectionId(response);
    return response;
  }

  private getAuthHeaders(): Promise<Record<string, string>> {
    return Promise.resolve(
      buildRemoteAuthHeaders({
        token: this.token,
        connectionId: this.connectionId,
      }),
    );
  }

  private captureConnectionId(response: Response): void {
    const header = readRemoteConnectionIdHeader(response);
    if (header !== undefined) {
      this.connectionId = header;
    }
  }

  private resolveConnectionId(): string {
    return resolveRemoteConnectionId({
      connectionId: this.connectionId,
      token: this.token,
    });
  }
}
