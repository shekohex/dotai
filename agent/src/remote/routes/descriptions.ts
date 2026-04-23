import type { TSchema } from "@sinclair/typebox";
import {
  ActiveToolsUpdateRequestSchema,
  AppSnapshotSchema,
  AuthChallengeRequestSchema,
  AuthChallengeResponseSchema,
  AuthVerifyRequestSchema,
  AuthVerifyResponseSchema,
  ClientCapabilitiesSchema,
  ClearQueueResponseSchema,
  CommandAcceptedResponseSchema,
  ConnectionCapabilitiesResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  ErrorResponseSchema,
  FollowUpCommandRequestSchema,
  InterruptCommandRequestSchema,
  ModelUpdateRequestSchema,
  PromptCommandRequestSchema,
  SessionNameUpdateRequestSchema,
  SessionSnapshotSchema,
  SessionToolsResponseSchema,
  SteerCommandRequestSchema,
  StreamReadResponseSchema,
  UiResponseRequestSchema,
  UiResponseResponseSchema,
} from "../schemas.js";

const sessionIdPathParameter = {
  in: "path" as const,
  name: "sessionId",
  schema: { type: "string" as const },
  required: true,
};

const connectionIdPathParameter = {
  in: "path" as const,
  name: "connectionId",
  schema: { type: "string" as const },
  required: true,
};

function streamQueryParameters() {
  return [
    {
      in: "query" as const,
      name: "offset",
      schema: { type: "string" as const },
      required: false,
    },
    {
      in: "query" as const,
      name: "live",
      schema: { type: "string" as const, enum: ["json", "sse", "long-poll"] },
      required: false,
    },
    {
      in: "query" as const,
      name: "timeoutMs",
      schema: { type: "string" as const },
      required: false,
    },
    {
      in: "query" as const,
      name: "cursor",
      schema: { type: "string" as const },
      required: false,
    },
  ];
}

function jsonContent(schema: TSchema) {
  return {
    "application/json": {
      schema,
    },
  };
}

function jsonResponse(description: string, schema: TSchema) {
  return {
    description,
    content: jsonContent(schema),
  };
}

function commandAcceptedResponses() {
  return {
    202: jsonResponse("Command accepted", CommandAcceptedResponseSchema),
    404: jsonResponse("Session not found", ErrorResponseSchema),
  };
}

function streamResponseDescription() {
  return {
    200: {
      description: "Stream events response",
      content: {
        ...jsonContent(StreamReadResponseSchema),
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

function commandRouteDescription(operationId: string, schema: TSchema) {
  return {
    tags: ["command"],
    operationId,
    parameters: [sessionIdPathParameter],
    requestBody: {
      required: true,
      content: jsonContent(schema),
    },
    responses: commandAcceptedResponses(),
  };
}

export const authChallengeRouteDescription = {
  tags: ["auth"],
  operationId: "requestAuthChallenge",
  requestBody: {
    required: true,
    content: jsonContent(AuthChallengeRequestSchema),
  },
  responses: {
    200: jsonResponse("Challenge issued", AuthChallengeResponseSchema),
    403: jsonResponse("Unknown key", ErrorResponseSchema),
  },
};

export const authVerifyRouteDescription = {
  tags: ["auth"],
  operationId: "verifyAuthChallenge",
  requestBody: {
    required: true,
    content: jsonContent(AuthVerifyRequestSchema),
  },
  responses: {
    200: jsonResponse("Token issued", AuthVerifyResponseSchema),
    401: jsonResponse("Invalid challenge verification", ErrorResponseSchema),
  },
};

export const appSnapshotRouteDescription = {
  tags: ["snapshot"],
  operationId: "getAppSnapshot",
  responses: {
    200: jsonResponse("App snapshot", AppSnapshotSchema),
    401: jsonResponse("Unauthorized", ErrorResponseSchema),
  },
};

export const updateConnectionCapabilitiesRouteDescription = {
  tags: ["connections"],
  operationId: "updateConnectionCapabilities",
  parameters: [connectionIdPathParameter],
  requestBody: {
    required: true,
    content: jsonContent(ClientCapabilitiesSchema),
  },
  responses: {
    200: jsonResponse("Connection capabilities updated", ConnectionCapabilitiesResponseSchema),
    401: jsonResponse("Unauthorized", ErrorResponseSchema),
  },
};

export const createSessionRouteDescription = {
  tags: ["command"],
  operationId: "createSession",
  requestBody: {
    required: true,
    content: jsonContent(CreateSessionRequestSchema),
  },
  responses: {
    201: jsonResponse("Session created", CreateSessionResponseSchema),
    409: jsonResponse("Milestone limit reached", ErrorResponseSchema),
  },
};

export const sessionSnapshotRouteDescription = {
  tags: ["snapshot"],
  operationId: "getSessionSnapshot",
  parameters: [sessionIdPathParameter],
  responses: {
    200: jsonResponse("Session snapshot", SessionSnapshotSchema),
    404: jsonResponse("Session not found", ErrorResponseSchema),
  },
};

export const sessionToolsRouteDescription = {
  tags: ["snapshot"],
  operationId: "getSessionTools",
  parameters: [sessionIdPathParameter],
  responses: {
    200: jsonResponse("Session tools", SessionToolsResponseSchema),
    404: jsonResponse("Session not found", ErrorResponseSchema),
  },
};

export const reloadSessionRouteDescription = {
  tags: ["command"],
  operationId: "reloadSession",
  parameters: [sessionIdPathParameter],
  responses: {
    200: jsonResponse("Session reloaded", SessionSnapshotSchema),
    401: jsonResponse("Unauthorized", ErrorResponseSchema),
    404: jsonResponse("Session not found", ErrorResponseSchema),
    409: jsonResponse("Session cannot be reloaded right now", ErrorResponseSchema),
  },
};

export const promptSessionRouteDescription = commandRouteDescription(
  "promptSession",
  PromptCommandRequestSchema,
);
export const steerSessionRouteDescription = commandRouteDescription(
  "steerSession",
  SteerCommandRequestSchema,
);
export const followUpSessionRouteDescription = commandRouteDescription(
  "followUpSession",
  FollowUpCommandRequestSchema,
);
export const interruptSessionRouteDescription = commandRouteDescription(
  "interruptSession",
  InterruptCommandRequestSchema,
);
export const updateSessionActiveToolsRouteDescription = commandRouteDescription(
  "updateSessionActiveTools",
  ActiveToolsUpdateRequestSchema,
);
export const updateSessionModelRouteDescription = commandRouteDescription(
  "updateSessionModel",
  ModelUpdateRequestSchema,
);
export const updateSessionNameRouteDescription = commandRouteDescription(
  "updateSessionName",
  SessionNameUpdateRequestSchema,
);

export const submitSessionUiResponseRouteDescription = {
  tags: ["command"],
  operationId: "submitSessionUiResponse",
  parameters: [sessionIdPathParameter],
  requestBody: {
    required: true,
    content: jsonContent(UiResponseRequestSchema),
  },
  responses: {
    200: jsonResponse("UI response accepted", UiResponseResponseSchema),
    404: jsonResponse("Session or UI request not found", ErrorResponseSchema),
  },
};

export const clearSessionQueueRouteDescription = {
  tags: ["command"],
  operationId: "clearSessionQueue",
  parameters: [sessionIdPathParameter],
  responses: {
    200: jsonResponse("Queue cleared", ClearQueueResponseSchema),
    404: jsonResponse("Session not found", ErrorResponseSchema),
  },
};

export const readAppEventsStreamRouteDescription = {
  tags: ["streams"],
  operationId: "readAppEventsStream",
  parameters: streamQueryParameters(),
  responses: streamResponseDescription(),
};

export const readSessionEventsStreamRouteDescription = {
  tags: ["streams"],
  operationId: "readSessionEventsStream",
  parameters: [sessionIdPathParameter, ...streamQueryParameters()],
  responses: streamResponseDescription(),
};
