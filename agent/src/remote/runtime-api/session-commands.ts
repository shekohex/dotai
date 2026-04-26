import { hc } from "hono/client";
import type { createV1Routes } from "../routes.js";
import type {
  ClearQueueResponse,
  SettingsUpdateRequest,
  UiResponseRequest,
  NavigateTreeRequest,
  NavigateTreeResponse,
  CompactRequest,
  CompactResponse,
  BashExecuteRequest,
  BashExecuteResponse,
  BashRecordRequest,
  BashRecordResponse,
  AbortOperationResponse,
} from "../schemas.js";
import {
  AbortOperationResponseSchema,
  BashExecuteResponseSchema,
  BashRecordResponseSchema,
  ClearQueueResponseSchema,
  CompactResponseSchema,
  NavigateTreeResponseSchema,
} from "../schemas.js";
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

export function postSettingsUpdateCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  body: SettingsUpdateRequest;
  postSessionRoute: PostSessionRoute;
}): Promise<void> {
  return input.postSessionRoute((headers) =>
    input.rpcClient.sessions[":sessionId"].settings.$post(
      { param: { sessionId: input.sessionId }, json: input.body },
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

export async function postNavigateTreeCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  body: NavigateTreeRequest;
  headers: Record<string, string>;
  captureConnectionId: (response: Response) => void;
}): Promise<NavigateTreeResponse> {
  const response = await input.rpcClient.sessions[":sessionId"]["navigate-tree"].$post(
    { param: { sessionId: input.sessionId }, json: input.body },
    { headers: input.headers },
  );
  input.captureConnectionId(response);
  if (response.status !== 200) {
    throw await toRemoteHttpError(response);
  }
  const payload: unknown = await response.json();
  assertType(NavigateTreeResponseSchema, payload);
  return payload;
}

export async function postCompactSessionCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  body: CompactRequest;
  headers: Record<string, string>;
  captureConnectionId: (response: Response) => void;
}): Promise<CompactResponse> {
  const response = await input.rpcClient.sessions[":sessionId"].compact.$post(
    { param: { sessionId: input.sessionId }, json: input.body },
    { headers: input.headers },
  );
  input.captureConnectionId(response);
  if (response.status !== 200) {
    throw await toRemoteHttpError(response);
  }
  const payload: unknown = await response.json();
  assertType(CompactResponseSchema, payload);
  return payload;
}

export async function postAbortCompactionCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  headers: Record<string, string>;
  captureConnectionId: (response: Response) => void;
}): Promise<AbortOperationResponse> {
  const response = await input.rpcClient.sessions[":sessionId"]["abort-compaction"].$post(
    { param: { sessionId: input.sessionId } },
    { headers: input.headers },
  );
  input.captureConnectionId(response);
  if (response.status !== 200) {
    throw await toRemoteHttpError(response);
  }
  const payload: unknown = await response.json();
  assertType(AbortOperationResponseSchema, payload);
  return payload;
}

export async function postExecuteBashCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  body: BashExecuteRequest;
  headers: Record<string, string>;
  captureConnectionId: (response: Response) => void;
}): Promise<BashExecuteResponse> {
  const response = await input.rpcClient.sessions[":sessionId"].bash.$post(
    { param: { sessionId: input.sessionId }, json: input.body },
    { headers: input.headers },
  );
  input.captureConnectionId(response);
  if (response.status !== 200) {
    throw await toRemoteHttpError(response);
  }
  const payload: unknown = await response.json();
  assertType(BashExecuteResponseSchema, payload);
  return payload;
}

export async function postAbortBashCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  headers: Record<string, string>;
  captureConnectionId: (response: Response) => void;
}): Promise<AbortOperationResponse> {
  const response = await input.rpcClient.sessions[":sessionId"]["abort-bash"].$post(
    { param: { sessionId: input.sessionId } },
    { headers: input.headers },
  );
  input.captureConnectionId(response);
  if (response.status !== 200) {
    throw await toRemoteHttpError(response);
  }
  const payload: unknown = await response.json();
  assertType(AbortOperationResponseSchema, payload);
  return payload;
}

export async function postRecordBashResultCommand(input: {
  rpcClient: ReturnType<typeof hc<RemoteV1Routes>>;
  sessionId: string;
  body: BashRecordRequest;
  headers: Record<string, string>;
  captureConnectionId: (response: Response) => void;
}): Promise<BashRecordResponse> {
  const response = await input.rpcClient.sessions[":sessionId"].bash.result.$post(
    { param: { sessionId: input.sessionId }, json: input.body },
    { headers: input.headers },
  );
  input.captureConnectionId(response);
  if (response.status !== 200) {
    throw await toRemoteHttpError(response);
  }
  const payload: unknown = await response.json();
  assertType(BashRecordResponseSchema, payload);
  return payload;
}
