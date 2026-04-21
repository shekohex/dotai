import {
  AppSnapshotSchema,
  AuthChallengeResponseSchema,
  AuthVerifyResponseSchema,
  ClearQueueResponseSchema,
  CreateSessionResponseSchema,
  SessionSnapshotSchema,
  UiResponseResponseSchema,
} from "../schemas.js";
import type {
  AuthChallengeRequest,
  AuthVerifyRequest,
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
  return withAuthError(c, () => {
    const connectionId = getConnectionId(c);
    const snapshot = dependencies.sessions.getSessionSnapshot(
      sessionId,
      c.get("auth"),
      connectionId,
    );
    return jsonWithSchema(c, SessionSnapshotSchema, snapshot, 200, connectionHeader(connectionId));
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
  return withAuthError(c, () => {
    const connectionId = getConnectionId(c);
    const cleared = dependencies.sessions.clearQueue(sessionId, c.get("auth"), connectionId);
    return jsonWithSchema(
      c,
      ClearQueueResponseSchema,
      cleared,
      200,
      connectionHeader(connectionId),
    );
  });
}
