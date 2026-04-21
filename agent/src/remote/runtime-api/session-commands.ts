import { hc } from "hono/client";
import type { createV1Routes } from "../routes.js";
import type { ClearQueueResponse, UiResponseRequest } from "../schemas.js";
import { ClearQueueResponseSchema } from "../schemas.js";
import { toRemoteHttpError } from "./utils.js";
import { assertType } from "../typebox.js";

type RemoteV1Routes = ReturnType<typeof createV1Routes>;

type PostSessionRoute = (
  request: (headers: Record<string, string>) => Promise<Response>,
) => Promise<void>;

export function postPromptCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  body: { text: string; attachments?: string[] };
  postSessionRoute: PostSessionRoute;
}): Promise<void> {
  return input.postSessionRoute((headers) =>
    input.rpcClient.sessions[":sessionId"].prompt.$post(
      { param: { sessionId: input.sessionId }, json: input.body },
      { headers },
    ),
  );
}

export function postSteerCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  body: { text: string; attachments?: string[] };
  postSessionRoute: PostSessionRoute;
}): Promise<void> {
  return input.postSessionRoute((headers) =>
    input.rpcClient.sessions[":sessionId"].steer.$post(
      { param: { sessionId: input.sessionId }, json: input.body },
      { headers },
    ),
  );
}

export function postFollowUpCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  body: { text: string; attachments?: string[] };
  postSessionRoute: PostSessionRoute;
}): Promise<void> {
  return input.postSessionRoute((headers) =>
    input.rpcClient.sessions[":sessionId"]["follow-up"].$post(
      { param: { sessionId: input.sessionId }, json: input.body },
      { headers },
    ),
  );
}

export function postInterruptCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  postSessionRoute: PostSessionRoute;
}): Promise<void> {
  return input.postSessionRoute((headers) =>
    input.rpcClient.sessions[":sessionId"].interrupt.$post(
      { param: { sessionId: input.sessionId }, json: {} },
      { headers },
    ),
  );
}

export function postActiveToolsUpdateCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  body: { toolNames: string[] };
  postSessionRoute: PostSessionRoute;
}): Promise<void> {
  return input.postSessionRoute((headers) =>
    input.rpcClient.sessions[":sessionId"]["active-tools"].$post(
      { param: { sessionId: input.sessionId }, json: input.body },
      { headers },
    ),
  );
}

export function postModelUpdateCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  body: { model: string; thinkingLevel?: string };
  postSessionRoute: PostSessionRoute;
}): Promise<void> {
  return input.postSessionRoute((headers) =>
    input.rpcClient.sessions[":sessionId"].model.$post(
      { param: { sessionId: input.sessionId }, json: input.body },
      { headers },
    ),
  );
}

export function postSessionNameUpdateCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  sessionName: string;
  postSessionRoute: PostSessionRoute;
}): Promise<void> {
  return input.postSessionRoute((headers) =>
    input.rpcClient.sessions[":sessionId"]["session-name"].$post(
      { param: { sessionId: input.sessionId }, json: { sessionName: input.sessionName } },
      { headers },
    ),
  );
}

export function postUiResponseCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  response: UiResponseRequest;
  postSessionRoute: PostSessionRoute;
}): Promise<void> {
  return input.postSessionRoute((headers) =>
    input.rpcClient.sessions[":sessionId"]["ui-response"].$post(
      { param: { sessionId: input.sessionId }, json: input.response },
      { headers },
    ),
  );
}

export async function clearRemoteSessionQueue(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  headers: Record<string, string>;
  captureConnectionId: (response: Response) => void;
}): Promise<ClearQueueResponse> {
  const response = await input.rpcClient.sessions[":sessionId"]["clear-queue"].$post(
    { param: { sessionId: input.sessionId } },
    { headers: input.headers },
  );
  input.captureConnectionId(response);
  if (response.status !== 200) {
    throw await toRemoteHttpError(response);
  }
  const payload: unknown = await response.json();
  assertType(ClearQueueResponseSchema, payload);
  return payload;
}
