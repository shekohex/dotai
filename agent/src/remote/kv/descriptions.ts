import type { TSchema } from "typebox";
import {
  RemoteKvDeleteResponseSchema,
  RemoteKvReadResponseSchema,
  RemoteKvWriteRequestSchema,
  RemoteKvWriteResponseSchema,
} from "./schemas.js";
import { ErrorResponseSchema } from "../schemas-core.js";

const remoteKvPathParameters = [
  {
    in: "path" as const,
    name: "scope",
    schema: { type: "string" as const, enum: ["global", "user"] },
    required: true,
  },
  {
    in: "path" as const,
    name: "namespace",
    schema: { type: "string" as const },
    required: true,
  },
  {
    in: "path" as const,
    name: "key",
    schema: { type: "string" as const },
    required: true,
  },
];

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

export const readRemoteKvRouteDescription = {
  tags: ["kv"],
  operationId: "readRemoteKv",
  parameters: remoteKvPathParameters,
  responses: {
    200: jsonResponse("KV value read", RemoteKvReadResponseSchema),
    401: jsonResponse("Unauthorized", ErrorResponseSchema),
  },
};

export const writeRemoteKvRouteDescription = {
  tags: ["kv"],
  operationId: "writeRemoteKv",
  parameters: remoteKvPathParameters,
  requestBody: {
    required: true,
    content: jsonContent(RemoteKvWriteRequestSchema),
  },
  responses: {
    200: jsonResponse("KV value written", RemoteKvWriteResponseSchema),
    401: jsonResponse("Unauthorized", ErrorResponseSchema),
  },
};

export const deleteRemoteKvRouteDescription = {
  tags: ["kv"],
  operationId: "deleteRemoteKv",
  parameters: remoteKvPathParameters,
  responses: {
    200: jsonResponse("KV value deleted", RemoteKvDeleteResponseSchema),
    401: jsonResponse("Unauthorized", ErrorResponseSchema),
  },
};
