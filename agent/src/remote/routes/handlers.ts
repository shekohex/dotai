import {
  AbortOperationResponseSchema,
  AppSnapshotSchema,
  AuthChallengeResponseSchema,
  AuthVerifyResponseSchema,
  BashExecuteResponseSchema,
  BashRecordResponseSchema,
  ConnectionCapabilitiesResponseSchema,
  ClearQueueResponseSchema,
  CompactResponseSchema,
  CreateSessionResponseSchema,
  ForkSessionResponseSchema,
  NavigateTreeResponseSchema,
  SessionDeletedResponseSchema,
  SessionForkMessagesResponseSchema,
  SessionSummarySchema,
  ToolDefinitionMetadataSchema,
  SessionToolsResponseSchema,
  SessionSnapshotSchema,
  UiResponseResponseSchema,
} from "../schemas.js";
import type {
  AuthChallengeRequest,
  AuthVerifyRequest,
  BashExecuteRequest,
  BashRecordRequest,
  ClientCapabilities,
  CompactRequest,
  CreateSessionRequest,
  ForkSessionRequest,
  NavigateTreeRequest,
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

export function handleArchiveSession(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
): Promise<Response> {
  return withAuthError(c, async () => {
    const summary = await dependencies.sessions.archiveSession(sessionId);
    return jsonWithSchema(c, SessionSummarySchema, summary);
  });
}

export function handleRestoreSession(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
): Promise<Response> {
  return withAuthError(c, () => {
    const summary = dependencies.sessions.restoreSession(sessionId);
    return jsonWithSchema(c, SessionSummarySchema, summary);
  });
}

export function handleDeleteSession(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
): Promise<Response> {
  return withAuthError(c, async () => {
    const response = await dependencies.sessions.deleteSession(sessionId);
    return jsonWithSchema(c, SessionDeletedResponseSchema, response);
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

export function handleSessionToolDefinition(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  toolName: string,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const definition = await dependencies.sessions.getSessionToolDefinition(
      sessionId,
      toolName,
      c.get("auth"),
      connectionId,
    );
    return jsonWithSchema(
      c,
      ToolDefinitionMetadataSchema,
      definition,
      200,
      connectionHeader(connectionId),
    );
  });
}

export function handleSessionForkMessages(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const messages = await dependencies.sessions.getSessionForkMessages(
      sessionId,
      c.get("auth"),
      connectionId,
    );
    return jsonWithSchema(c, SessionForkMessagesResponseSchema, { messages });
  });
}

export function handleForkSession(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: ForkSessionRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const forked = await dependencies.sessions.forkSession(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return jsonWithSchema(
      c,
      ForkSessionResponseSchema,
      forked,
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

export function handleNavigateTree(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: NavigateTreeRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const result = await dependencies.sessions.navigateTree(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return jsonWithSchema(
      c,
      NavigateTreeResponseSchema,
      result,
      200,
      connectionHeader(connectionId),
    );
  });
}

export function handleCompactSession(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: CompactRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const result = await dependencies.sessions.compactSession(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return jsonWithSchema(c, CompactResponseSchema, result, 200, connectionHeader(connectionId));
  });
}

export function handleAbortCompaction(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    await dependencies.sessions.abortCompaction(sessionId, c.get("auth"), connectionId);
    return jsonWithSchema(
      c,
      AbortOperationResponseSchema,
      { ok: true },
      200,
      connectionHeader(connectionId),
    );
  });
}

export function handleExecuteBash(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: BashExecuteRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const result = await dependencies.sessions.executeBash(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return jsonWithSchema(
      c,
      BashExecuteResponseSchema,
      result,
      200,
      connectionHeader(connectionId),
    );
  });
}

export function handleAbortBash(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    await dependencies.sessions.abortBash(sessionId, c.get("auth"), connectionId);
    return jsonWithSchema(
      c,
      AbortOperationResponseSchema,
      { ok: true },
      200,
      connectionHeader(connectionId),
    );
  });
}

export function handleRecordBashResult(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: BashRecordRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const result = await dependencies.sessions.recordBashResult(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return jsonWithSchema(c, BashRecordResponseSchema, result, 200, connectionHeader(connectionId));
  });
}
