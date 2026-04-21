import { hc } from "hono/client";
import type { createV1Routes } from "./routes.js";
import type {
  AppSnapshot,
  ClearQueueResponse,
  CreateSessionResponse,
  SessionSnapshot,
  UiResponseRequest,
} from "./schemas.js";
import {
  AppSnapshotSchema,
  ClearQueueResponseSchema,
  CreateSessionResponseSchema,
  SessionSnapshotSchema,
} from "./schemas.js";
import { assertType } from "./typebox.js";
import {
  requestRemoteAuthToken,
  type RemoteApiClientAuthOptions,
} from "./remote-api-client-auth.js";
import {
  type ReadSessionEventsOptions,
  type StreamReadResult,
  readSessionEventsFromSse,
  toRemoteHttpError,
} from "./remote-api-client-utils.js";

type RemoteV1Routes = ReturnType<typeof createV1Routes>;
type AuthFlowMode = "normal" | "forced";

export class RemoteApiClient {
  private readonly rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  private readonly auth: RemoteApiClientAuthOptions;
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private token: string | undefined;
  private connectionId: string | undefined;
  private authTask: Promise<void> | undefined;
  private readonly sessionStreamCursors = new Map<string, string>();
  constructor(options: {
    origin: string;
    auth: RemoteApiClientAuthOptions;
    connectionId?: string;
    fetchImpl?: typeof fetch;
  }) {
    const origin = options.origin.replace(/\/$/, "");
    this.origin = origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rpcClient = hc<RemoteV1Routes>(`${origin}/v1`, { fetch: options.fetchImpl });
    this.auth = options.auth;
    this.connectionId = options.connectionId;
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

  async createSession(sessionName?: string): Promise<CreateSessionResponse> {
    const response = await this.rpcClient.sessions.$post(
      { json: sessionName !== undefined && sessionName.length > 0 ? { sessionName } : {} },
      { headers: await this.getAuthHeaders() },
    );
    this.captureConnectionId(response);
    if (response.status !== 201) throw await toRemoteHttpError(response);
    const payload: unknown = await response.json();
    assertType(CreateSessionResponseSchema, payload);
    return payload;
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

  async prompt(sessionId: string, body: { text: string; attachments?: string[] }): Promise<void> {
    await this.postSessionRoute((headers) =>
      this.rpcClient.sessions[":sessionId"].prompt.$post(
        { param: { sessionId }, json: body },
        { headers },
      ),
    );
  }
  async steer(sessionId: string, body: { text: string; attachments?: string[] }): Promise<void> {
    await this.postSessionRoute((headers) =>
      this.rpcClient.sessions[":sessionId"].steer.$post(
        { param: { sessionId }, json: body },
        { headers },
      ),
    );
  }
  async followUp(sessionId: string, body: { text: string; attachments?: string[] }): Promise<void> {
    await this.postSessionRoute((headers) =>
      this.rpcClient.sessions[":sessionId"]["follow-up"].$post(
        { param: { sessionId }, json: body },
        { headers },
      ),
    );
  }
  async interrupt(sessionId: string): Promise<void> {
    await this.postSessionRoute((headers) =>
      this.rpcClient.sessions[":sessionId"].interrupt.$post(
        { param: { sessionId }, json: {} },
        { headers },
      ),
    );
  }
  async updateModel(
    sessionId: string,
    body: { model: string; thinkingLevel?: string },
  ): Promise<void> {
    await this.postSessionRoute((headers) =>
      this.rpcClient.sessions[":sessionId"].model.$post(
        { param: { sessionId }, json: body },
        { headers },
      ),
    );
  }
  async updateSessionName(sessionId: string, sessionName: string): Promise<void> {
    await this.postSessionRoute((headers) =>
      this.rpcClient.sessions[":sessionId"]["session-name"].$post(
        { param: { sessionId }, json: { sessionName } },
        { headers },
      ),
    );
  }
  async postUiResponse(sessionId: string, response: UiResponseRequest): Promise<void> {
    await this.postSessionRoute((headers) =>
      this.rpcClient.sessions[":sessionId"]["ui-response"].$post(
        { param: { sessionId }, json: response },
        { headers },
      ),
    );
  }

  async clearQueue(sessionId: string): Promise<ClearQueueResponse> {
    const response = await this.rpcClient.sessions[":sessionId"]["clear-queue"].$post(
      { param: { sessionId } },
      { headers: await this.getAuthHeaders() },
    );
    this.captureConnectionId(response);
    if (response.status !== 200) throw await toRemoteHttpError(response);
    const payload: unknown = await response.json();
    assertType(ClearQueueResponseSchema, payload);
    return payload;
  }

  async readSessionEvents(
    sessionId: string,
    offset: string,
    options?: ReadSessionEventsOptions,
  ): Promise<StreamReadResult> {
    const response = await this.fetchSessionEventsResponse(sessionId, offset, options?.signal);
    if (response.status === 204) {
      return this.buildNoContentSessionEventsResult(response, sessionId, offset);
    }
    if (!response.ok) throw await toRemoteHttpError(response);
    const sseRead = await readSessionEventsFromSse({
      response,
      fallbackOffset: offset,
      onEvent: options?.onEvent,
      onControl: options?.onControl,
      signal: options?.signal,
    });
    this.updateSessionStreamCursor(sessionId, sseRead.streamCursor);
    return {
      events: sseRead.events,
      nextOffset: sseRead.nextOffset,
      streamClosed: sseRead.streamClosed,
    };
  }

  private async postSessionRoute(
    request: (headers: Record<string, string>) => Promise<Response>,
  ): Promise<void> {
    const response = await request(await this.getAuthHeaders());
    this.captureConnectionId(response);
    if (!response.ok) throw await toRemoteHttpError(response);
  }

  private async fetchSessionEventsResponse(
    sessionId: string,
    offset: string,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const response = await this.fetchImpl(this.buildSessionEventsRequestUrl(sessionId, offset), {
      method: "GET",
      headers: await this.getAuthHeaders(),
      signal,
    });
    this.captureConnectionId(response);
    return response;
  }

  private buildSessionEventsRequestUrl(sessionId: string, offset: string): string {
    const cursor = this.sessionStreamCursors.get(sessionId);
    const query = new URLSearchParams({
      live: "sse",
      offset,
      ...(cursor !== undefined && cursor.length > 0 ? { cursor } : {}),
    });
    return `${this.origin}/v1/streams/sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`;
  }

  private buildNoContentSessionEventsResult(
    response: Response,
    sessionId: string,
    fallbackOffset: string,
  ): StreamReadResult {
    const nextOffset = response.headers.get("Stream-Next-Offset") ?? fallbackOffset;
    this.updateSessionStreamCursor(sessionId, response.headers.get("Stream-Cursor") ?? undefined);
    return {
      events: [],
      nextOffset,
      streamClosed: response.headers.get("Stream-Closed") === "true",
    };
  }

  private updateSessionStreamCursor(sessionId: string, cursor: string | undefined): void {
    if (cursor !== undefined && cursor.length > 0) this.sessionStreamCursors.set(sessionId, cursor);
    else this.sessionStreamCursors.delete(sessionId);
  }

  private getAuthHeaders(): Promise<Record<string, string>> {
    if (this.token === undefined || this.token.length === 0) {
      throw new Error("Remote auth token is missing");
    }
    return Promise.resolve({
      authorization: `Bearer ${this.token}`,
      ...(this.connectionId !== undefined && this.connectionId.length > 0
        ? { "x-pi-connection-id": this.connectionId }
        : {}),
    });
  }

  private captureConnectionId(response: Response): void {
    const header = response.headers.get("x-pi-connection-id");
    if (header !== null && header.length > 0) this.connectionId = header;
  }
}
