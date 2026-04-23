import {
  AppSnapshotSchema,
  AuthChallengeResponseSchema,
  AuthVerifyResponseSchema,
  ConnectionCapabilitiesResponseSchema,
  ClearQueueResponseSchema,
  CreateSessionResponseSchema,
  SessionSummarySchema,
  SessionToolsResponseSchema,
  SessionSnapshotSchema,
  UiResponseResponseSchema,
} from "../schemas.js";
import type {
  AuthChallengeRequest,
  AuthVerifyRequest,
  ClientCapabilities,
  CreateSessionRequest,
  UiResponseRequest,
} from "../schemas.js";
import { jsonWithSchema } from "../typebox.js";
import {
  connectionHeader,
  getConnectionId,
  type HonoContext,
  withAuthError,
} from "./handler-shared.js";
import type { RemoteRoutesDependencies } from "./types.js";

export function handleAuthChallenge(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  payload: AuthChallengeRequest,
): Promise<Response> {
  return withAuthError(c, () => {
    const challenge = dependencies.auth.createChallenge(payload.keyId);
    return jsonWithSchema(c, AuthChallengeResponseSchema, challenge);
  });
}

export function handleAuthVerify(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  payload: AuthVerifyRequest,
): Promise<Response> {
  return withAuthError(c, () => {
    const verified = dependencies.auth.verifyChallenge(payload);
    return jsonWithSchema(c, AuthVerifyResponseSchema, {
      token: verified.token,
      tokenType: "Bearer",
      expiresAt: verified.expiresAt,
      clientId: verified.clientId,
      keyId: verified.keyId,
    });
  });
}

export function handleAppSnapshot(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
): Promise<Response> {
  return withAuthError(c, () => {
    const snapshot = dependencies.sessions.getAppSnapshot(c.get("auth"));
    return jsonWithSchema(c, AppSnapshotSchema, snapshot);
  });
}

export function handleUpdateConnectionCapabilities(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  connectionId: string,
  payload: ClientCapabilities,
): Promise<Response> {
  return withAuthError(c, () => {
    const updated = dependencies.sessions.setConnectionCapabilities(
      connectionId,
      payload,
      c.get("auth"),
    );
    return jsonWithSchema(
      c,
      ConnectionCapabilitiesResponseSchema,
      updated,
      200,
      connectionHeader(connectionId),
    );
  });
}

export function handleCreateSession(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  payload: CreateSessionRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const session = await dependencies.sessions.createSession(payload, c.get("auth"), connectionId);
    return jsonWithSchema(
      c,
      CreateSessionResponseSchema,
      session,
      201,
      connectionHeader(connectionId),
    );
  });
}

export function handleSessionSnapshot(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const snapshot = await dependencies.sessions.loadSessionSnapshot(
      sessionId,
      c.get("auth"),
      connectionId,
    );
    return jsonWithSchema(c, SessionSnapshotSchema, snapshot, 200, connectionHeader(connectionId));
  });
}

export function handleSessionSummary(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
): Promise<Response> {
  return withAuthError(c, () => {
    const summary = dependencies.sessions.getSessionSummary(sessionId);
    return jsonWithSchema(c, SessionSummarySchema, summary);
  });
}

export function handleReloadSession(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const snapshot = await dependencies.sessions.reload(sessionId, c.get("auth"), connectionId);
    return jsonWithSchema(c, SessionSnapshotSchema, snapshot, 200, connectionHeader(connectionId));
  });
}

export function handleSessionTools(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const tools = await dependencies.sessions.getSessionTools(
      sessionId,
      c.get("auth"),
      connectionId,
    );
    return jsonWithSchema(
      c,
      SessionToolsResponseSchema,
      { tools },
      200,
      connectionHeader(connectionId),
    );
  });
}

export function handleSubmitSessionUiResponse(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: UiResponseRequest,
): Promise<Response> {
  return withAuthError(c, () => {
    const connectionId = getConnectionId(c);
    const resolved = dependencies.sessions.submitUiResponse(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return jsonWithSchema(
      c,
      UiResponseResponseSchema,
      resolved,
      200,
      connectionHeader(connectionId),
    );
  });
}

export function handleClearSessionQueue(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const cleared = await dependencies.sessions.clearQueue(sessionId, c.get("auth"), connectionId);
    return jsonWithSchema(
      c,
      ClearQueueResponseSchema,
      cleared,
      200,
      connectionHeader(connectionId),
    );
  });
}
