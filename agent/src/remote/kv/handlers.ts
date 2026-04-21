import {
  RemoteKvDeleteResponseSchema,
  RemoteKvReadResponseSchema,
  RemoteKvWriteResponseSchema,
} from "./schemas.js";
import type { RemoteKvItemParams, RemoteKvWriteRequest } from "../schemas.js";
import { jsonWithSchema } from "../typebox.js";
import { type HonoContext, withAuthError } from "../routes/handler-shared.js";
import type { RemoteRoutesDependencies } from "../routes/types.js";

export function handleReadRemoteKv(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  params: RemoteKvItemParams,
): Promise<Response> {
  return withAuthError(c, async () => {
    const result = await dependencies.kv.read({
      scope: params.scope,
      namespace: params.namespace,
      key: params.key,
      keyId: c.get("auth").keyId,
    });
    return jsonWithSchema(c, RemoteKvReadResponseSchema, result);
  });
}

export function handleWriteRemoteKv(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  params: RemoteKvItemParams,
  payload: RemoteKvWriteRequest,
): Promise<Response> {
  return withAuthError(c, async () => {
    const result = await dependencies.kv.write({
      scope: params.scope,
      namespace: params.namespace,
      key: params.key,
      value: payload.value,
      keyId: c.get("auth").keyId,
    });
    return jsonWithSchema(c, RemoteKvWriteResponseSchema, result);
  });
}

export function handleDeleteRemoteKv(
  c: HonoContext,
  dependencies: RemoteRoutesDependencies,
  params: RemoteKvItemParams,
): Promise<Response> {
  return withAuthError(c, async () => {
    const result = await dependencies.kv.delete({
      scope: params.scope,
      namespace: params.namespace,
      key: params.key,
      keyId: c.get("auth").keyId,
    });
    return jsonWithSchema(c, RemoteKvDeleteResponseSchema, result);
  });
}
