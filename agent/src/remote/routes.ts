import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { tbValidator } from "@hono/typebox-validator";
import { describeRoute } from "hono-openapi";
import type { AuthService, AuthSession } from "./auth.js";
import { RemoteError } from "./errors.js";
import {
  AppSnapshotSchema,
  AuthChallengeRequestSchema,
  AuthChallengeResponseSchema,
  AuthVerifyRequestSchema,
  AuthVerifyResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  ErrorResponseSchema,
  SessionParamsSchema,
  SessionSnapshotSchema,
  StreamReadQuerySchema,
  StreamReadResponseSchema,
} from "./schemas.js";
import { generateResponseCursor } from "./cursor.js";
import type { SessionRegistry } from "./session-registry.js";
import { InMemoryDurableStreamStore, appEventsStreamId, sessionEventsStreamId } from "./streams.js";
import { jsonWithSchema } from "./typebox.js";

export interface RemoteHonoEnv {
  Variables: {
    auth: AuthSession;
  };
}

export interface RemoteRoutesDependencies {
  auth: AuthService;
  sessions: SessionRegistry;
  streams: InMemoryDurableStreamStore;
}

function authError(c: Parameters<MiddlewareHandler<RemoteHonoEnv>>[0], error: unknown): Response {
  if (error instanceof RemoteError) {
    return jsonWithSchema(
      c,
      ErrorResponseSchema,
      { error: error.message },
      error.status as 400 | 401 | 403 | 404 | 409 | 500,
    );
  }
  if (error instanceof Error) {
    return jsonWithSchema(
      c,
      ErrorResponseSchema,
      { error: "Unexpected error", details: error.message },
      500,
    );
  }
  return jsonWithSchema(c, ErrorResponseSchema, { error: "Unexpected error" }, 500);
}

function requireAuth(authService: AuthService): MiddlewareHandler<RemoteHonoEnv> {
  return async (c, next) => {
    try {
      const session = authService.authenticate(c.req.header("authorization"));
      c.set("auth", session);
      await next();
    } catch (error) {
      return authError(c, error);
    }
  };
}

function sseEventChunk(event: unknown, id?: string, eventName = "message"): string {
  const idPart = id ? `id: ${id}\n` : "";
  return `${idPart}event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
}

function streamStateHeaders(input: {
  nextOffset: string;
  upToDate: boolean;
  streamClosed: boolean;
  streamCursor?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Stream-Next-Offset": input.nextOffset,
    "Stream-Up-To-Date": String(input.upToDate),
  };
  if (input.streamClosed) {
    headers["Stream-Closed"] = "true";
  }
  if (input.streamCursor && !input.streamClosed) {
    headers["Stream-Cursor"] = input.streamCursor;
  }
  return headers;
}

function getConnectionId(c: Parameters<MiddlewareHandler<RemoteHonoEnv>>[0]): string {
  const providedConnectionId = c.req.header("x-pi-connection-id")?.trim();
  if (providedConnectionId) {
    return providedConnectionId;
  }
  return c.get("auth").token;
}

function streamEventsSse(
  streamId: string,
  offset: string | undefined,
  cursor: string | undefined,
  connectionId: string,
  streams: InMemoryDurableStreamStore,
  onDisconnect?: () => void,
): Response {
  const encoder = new TextEncoder();
  let currentCursor = generateResponseCursor(cursor);
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const subscription = streams.readAndSubscribe(streamId, offset, (event) => {
    if (!controller) {
      return;
    }
    controller.enqueue(encoder.encode(sseEventChunk(event, event.streamOffset, "data")));
    currentCursor = generateResponseCursor(currentCursor);
    controller.enqueue(
      encoder.encode(
        sseEventChunk(
          {
            streamNextOffset: streams.getHeadOffset(streamId),
            streamCursor: currentCursor,
            upToDate: true,
            streamClosed: false,
          },
          undefined,
          "control",
        ),
      ),
    );
  });
  const initial = subscription.read;

  const body = new ReadableStream<Uint8Array>({
    start(activeController) {
      controller = activeController;
      for (const event of initial.events) {
        activeController.enqueue(encoder.encode(sseEventChunk(event, event.streamOffset, "data")));
      }

      activeController.enqueue(
        encoder.encode(
          sseEventChunk(
            {
              streamNextOffset: initial.nextOffset,
              ...(initial.streamClosed ? {} : { streamCursor: currentCursor }),
              upToDate: initial.upToDate,
              streamClosed: initial.streamClosed,
            },
            undefined,
            "control",
          ),
        ),
      );

      if (initial.streamClosed) {
        activeController.close();
        return;
      }
    },
    cancel() {
      subscription.unsubscribe();
      controller = undefined;
      onDisconnect?.();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-pi-connection-id": connectionId,
      ...streamStateHeaders({
        ...initial,
        streamCursor: initial.streamClosed ? undefined : currentCursor,
      }),
    },
  });
}

function parseTimeout(timeoutMs: string | undefined): number {
  if (!timeoutMs) {
    return 25_000;
  }
  const parsed = Number.parseInt(timeoutMs, 10);
  if (Number.isNaN(parsed)) {
    return 25_000;
  }
  return Math.min(Math.max(parsed, 250), 60_000);
}

function requireLiveOffset(mode: "sse" | "long-poll", offset: string | undefined): void {
  if (offset) {
    return;
  }
  throw new RemoteError(`${mode === "sse" ? "SSE" : "Long-poll"} requires offset parameter`, 400);
}

function streamResponseDescription() {
  return {
    200: {
      description: "Stream events response",
      content: {
        "application/json": {
          schema: StreamReadResponseSchema,
        },
        "text/event-stream": {
          schema: {
            type: "string" as const,
            description: "SSE stream with data/control events when live=sse",
          },
        },
      },
    },
    204: {
      description: "No new events available",
    },
  };
}

export function createV1Routes(dependencies: RemoteRoutesDependencies): Hono<RemoteHonoEnv> {
  const v1 = new Hono<RemoteHonoEnv>();
  const needsAuth = requireAuth(dependencies.auth);

  v1.post(
    "/auth/challenge",
    describeRoute({
      tags: ["auth"],
      operationId: "requestAuthChallenge",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: AuthChallengeRequestSchema,
          },
        },
      },
      responses: {
        200: {
          description: "Challenge issued",
          content: {
            "application/json": {
              schema: AuthChallengeResponseSchema,
            },
          },
        },
        403: {
          description: "Unknown key",
          content: {
            "application/json": {
              schema: ErrorResponseSchema,
            },
          },
        },
      },
    }),
    tbValidator("json", AuthChallengeRequestSchema),
    (c) => {
      try {
        const payload = c.req.valid("json");
        const challenge = dependencies.auth.createChallenge(payload.keyId);
        return jsonWithSchema(c, AuthChallengeResponseSchema, challenge);
      } catch (error) {
        return authError(c, error);
      }
    },
  );

  v1.post(
    "/auth/verify",
    describeRoute({
      tags: ["auth"],
      operationId: "verifyAuthChallenge",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: AuthVerifyRequestSchema,
          },
        },
      },
      responses: {
        200: {
          description: "Token issued",
          content: {
            "application/json": {
              schema: AuthVerifyResponseSchema,
            },
          },
        },
        401: {
          description: "Invalid challenge verification",
          content: {
            "application/json": {
              schema: ErrorResponseSchema,
            },
          },
        },
      },
    }),
    tbValidator("json", AuthVerifyRequestSchema),
    (c) => {
      try {
        const payload = c.req.valid("json");
        const verified = dependencies.auth.verifyChallenge(payload);
        return jsonWithSchema(c, AuthVerifyResponseSchema, {
          token: verified.token,
          tokenType: "Bearer",
          expiresAt: verified.expiresAt,
          clientId: verified.clientId,
          keyId: verified.keyId,
        });
      } catch (error) {
        return authError(c, error);
      }
    },
  );

  v1.get(
    "/app/snapshot",
    describeRoute({
      tags: ["snapshot"],
      operationId: "getAppSnapshot",
      responses: {
        200: {
          description: "App snapshot",
          content: {
            "application/json": {
              schema: AppSnapshotSchema,
            },
          },
        },
        401: {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: ErrorResponseSchema,
            },
          },
        },
      },
    }),
    needsAuth,
    (c) => {
      try {
        const auth = c.get("auth");
        const snapshot = dependencies.sessions.getAppSnapshot(auth);
        return jsonWithSchema(c, AppSnapshotSchema, snapshot);
      } catch (error) {
        return authError(c, error);
      }
    },
  );

  v1.post(
    "/sessions",
    describeRoute({
      tags: ["command"],
      operationId: "createSession",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: CreateSessionRequestSchema,
          },
        },
      },
      responses: {
        201: {
          description: "Session created",
          content: {
            "application/json": {
              schema: CreateSessionResponseSchema,
            },
          },
        },
        409: {
          description: "Milestone limit reached",
          content: {
            "application/json": {
              schema: ErrorResponseSchema,
            },
          },
        },
      },
    }),
    needsAuth,
    tbValidator("json", CreateSessionRequestSchema),
    async (c) => {
      try {
        const connectionId = getConnectionId(c);
        const payload = c.req.valid("json");
        const session = await dependencies.sessions.createSession(
          payload,
          c.get("auth"),
          connectionId,
        );
        return jsonWithSchema(c, CreateSessionResponseSchema, session, 201, {
          "x-pi-connection-id": connectionId,
        });
      } catch (error) {
        return authError(c, error);
      }
    },
  );

  v1.get(
    "/sessions/:sessionId/snapshot",
    describeRoute({
      tags: ["snapshot"],
      operationId: "getSessionSnapshot",
      parameters: [
        {
          in: "path",
          name: "sessionId",
          schema: { type: "string" },
          required: true,
        },
      ],
      responses: {
        200: {
          description: "Session snapshot",
          content: {
            "application/json": {
              schema: SessionSnapshotSchema,
            },
          },
        },
        404: {
          description: "Session not found",
          content: {
            "application/json": {
              schema: ErrorResponseSchema,
            },
          },
        },
      },
    }),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    (c) => {
      try {
        const connectionId = getConnectionId(c);
        const { sessionId } = c.req.valid("param");
        const snapshot = dependencies.sessions.getSessionSnapshot(
          sessionId,
          c.get("auth"),
          connectionId,
        );
        return jsonWithSchema(c, SessionSnapshotSchema, snapshot, 200, {
          "x-pi-connection-id": connectionId,
        });
      } catch (error) {
        return authError(c, error);
      }
    },
  );

  v1.get(
    "/streams/app-events",
    describeRoute({
      tags: ["streams"],
      operationId: "readAppEventsStream",
      parameters: [
        {
          in: "query",
          name: "offset",
          schema: { type: "string" },
          required: false,
        },
        {
          in: "query",
          name: "live",
          schema: { type: "string", enum: ["json", "sse", "long-poll"] },
          required: false,
        },
        {
          in: "query",
          name: "timeoutMs",
          schema: { type: "string" },
          required: false,
        },
        {
          in: "query",
          name: "cursor",
          schema: { type: "string" },
          required: false,
        },
      ],
      responses: streamResponseDescription(),
    }),
    needsAuth,
    tbValidator("query", StreamReadQuerySchema),
    async (c) => {
      try {
        const query = c.req.valid("query");
        const streamId = appEventsStreamId();
        const mode = query.live ?? "json";
        if (mode === "sse" || mode === "long-poll") {
          requireLiveOffset(mode, query.offset);
        }
        if (mode === "sse") {
          const connectionId = getConnectionId(c);
          return streamEventsSse(
            streamId,
            query.offset,
            query.cursor,
            connectionId,
            dependencies.streams,
          );
        }
        if (mode === "long-poll") {
          const read = await dependencies.streams.waitForEvents(
            streamId,
            query.offset,
            parseTimeout(query.timeoutMs),
          );
          const streamCursor = read.streamClosed ? undefined : generateResponseCursor(query.cursor);
          if (read.events.length === 0 && (read.timedOut || read.streamClosed)) {
            return new Response(null, {
              status: 204,
              headers: streamStateHeaders({
                ...read,
                streamCursor,
              }),
            });
          }
          return jsonWithSchema(
            c,
            StreamReadResponseSchema,
            {
              streamId,
              fromOffset: read.fromOffset,
              nextOffset: read.nextOffset,
              ...(streamCursor ? { streamCursor } : {}),
              upToDate: read.upToDate,
              streamClosed: read.streamClosed,
              events: read.events,
            },
            200,
            streamStateHeaders({
              ...read,
              streamCursor,
            }),
          );
        }
        const read = dependencies.streams.read(streamId, query.offset);
        return jsonWithSchema(
          c,
          StreamReadResponseSchema,
          {
            streamId,
            fromOffset: read.fromOffset,
            nextOffset: read.nextOffset,
            upToDate: read.upToDate,
            streamClosed: read.streamClosed,
            events: read.events,
          },
          200,
          streamStateHeaders(read),
        );
      } catch (error) {
        return authError(c, error);
      }
    },
  );

  v1.get(
    "/streams/sessions/:sessionId/events",
    describeRoute({
      tags: ["streams"],
      operationId: "readSessionEventsStream",
      parameters: [
        {
          in: "path",
          name: "sessionId",
          schema: { type: "string" },
          required: true,
        },
        {
          in: "query",
          name: "offset",
          schema: { type: "string" },
          required: false,
        },
        {
          in: "query",
          name: "live",
          schema: { type: "string", enum: ["json", "sse", "long-poll"] },
          required: false,
        },
        {
          in: "query",
          name: "timeoutMs",
          schema: { type: "string" },
          required: false,
        },
        {
          in: "query",
          name: "cursor",
          schema: { type: "string" },
          required: false,
        },
      ],
      responses: streamResponseDescription(),
    }),
    needsAuth,
    tbValidator("param", SessionParamsSchema),
    tbValidator("query", StreamReadQuerySchema),
    async (c) => {
      try {
        const connectionId = getConnectionId(c);
        const { sessionId } = c.req.valid("param");
        const query = c.req.valid("query");
        dependencies.sessions.touchPresence(sessionId, c.get("auth"), connectionId);
        const streamId = sessionEventsStreamId(sessionId);
        const mode = query.live ?? "json";
        if (mode === "sse" || mode === "long-poll") {
          requireLiveOffset(mode, query.offset);
        }
        if (mode === "sse") {
          return streamEventsSse(
            streamId,
            query.offset,
            query.cursor,
            connectionId,
            dependencies.streams,
            () => {
              dependencies.sessions.detachPresence(sessionId, connectionId);
            },
          );
        }
        if (mode === "long-poll") {
          const read = await dependencies.streams.waitForEvents(
            streamId,
            query.offset,
            parseTimeout(query.timeoutMs),
          );
          const streamCursor = read.streamClosed ? undefined : generateResponseCursor(query.cursor);
          if (read.events.length === 0 && (read.timedOut || read.streamClosed)) {
            return new Response(null, {
              status: 204,
              headers: {
                ...streamStateHeaders({
                  ...read,
                  streamCursor,
                }),
                "x-pi-connection-id": connectionId,
              },
            });
          }
          return jsonWithSchema(
            c,
            StreamReadResponseSchema,
            {
              streamId,
              fromOffset: read.fromOffset,
              nextOffset: read.nextOffset,
              ...(streamCursor ? { streamCursor } : {}),
              upToDate: read.upToDate,
              streamClosed: read.streamClosed,
              events: read.events,
            },
            200,
            {
              ...streamStateHeaders({
                ...read,
                streamCursor,
              }),
              "x-pi-connection-id": connectionId,
            },
          );
        }
        const read = dependencies.streams.read(streamId, query.offset);
        return jsonWithSchema(
          c,
          StreamReadResponseSchema,
          {
            streamId,
            fromOffset: read.fromOffset,
            nextOffset: read.nextOffset,
            upToDate: read.upToDate,
            streamClosed: read.streamClosed,
            events: read.events,
          },
          200,
          {
            ...streamStateHeaders(read),
            "x-pi-connection-id": connectionId,
          },
        );
      } catch (error) {
        return authError(c, error);
      }
    },
  );

  return v1;
}
