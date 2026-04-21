import type {
  ActiveToolsUpdateRequest,
  FollowUpCommandRequest,
  InterruptCommandRequest,
  ModelUpdateRequest,
  PromptCommandRequest,
  SessionNameUpdateRequest,
  SteerCommandRequest,
} from "../schemas.js";
import {
  acceptedResponse,
  getConnectionId,
  type HonoContext,
  withAuthError,
} from "./handler-shared.js";
import type { RemoteRoutesDependencies } from "./types.js";

export function handlePromptSession(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: PromptCommandRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const accepted = await dependencies.sessions.prompt(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return acceptedResponse(c, accepted, connectionId);
  });
}

export function handleSteerSession(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: SteerCommandRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const accepted = await dependencies.sessions.steer(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return acceptedResponse(c, accepted, connectionId);
  });
}

export function handleFollowUpSession(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: FollowUpCommandRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const accepted = await dependencies.sessions.followUp(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return acceptedResponse(c, accepted, connectionId);
  });
}

export function handleInterruptSession(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: InterruptCommandRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const accepted = await dependencies.sessions.interrupt(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return acceptedResponse(c, accepted, connectionId);
  });
}

export function handleUpdateSessionActiveTools(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: ActiveToolsUpdateRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const accepted = await dependencies.sessions.updateActiveTools(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return acceptedResponse(c, accepted, connectionId);
  });
}

export function handleUpdateSessionModel(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: ModelUpdateRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const accepted = await dependencies.sessions.updateModel(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return acceptedResponse(c, accepted, connectionId);
  });
}

export function handleUpdateSessionName(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  sessionId: string,
  payload: SessionNameUpdateRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const connectionId = getConnectionId(c);
    const accepted = await dependencies.sessions.updateSessionName(
      sessionId,
      payload,
      c.get("auth"),
      connectionId,
    );
    return acceptedResponse(c, accepted, connectionId);
  });
}
