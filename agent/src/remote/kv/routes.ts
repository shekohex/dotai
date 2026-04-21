import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { tbValidator } from "@hono/typebox-validator";
import { describeRoute } from "hono-openapi";
import { RemoteKvItemParamsSchema, RemoteKvWriteRequestSchema } from "./schemas.js";
import {
  deleteRemoteKvRouteDescription,
  readRemoteKvRouteDescription,
  writeRemoteKvRouteDescription,
} from "./descriptions.js";
import { handleDeleteRemoteKv, handleReadRemoteKv, handleWriteRemoteKv } from "./handlers.js";
import type { RemoteHonoEnv, RemoteRoutesDependencies } from "../routes/types.js";

export function createRemoteKvRoutes(
  dependencies: RemoteRoutesDependencies,
  needsAuth: MiddlewareHandler<RemoteHonoEnv>,
): Hono<RemoteHonoEnv> {
  const kv = new Hono<RemoteHonoEnv>();

  kv.get(
    "/:scope/:namespace/:key",
    describeRoute(readRemoteKvRouteDescription),
    needsAuth,
    tbValidator("param", RemoteKvItemParamsSchema),
    (c) => handleReadRemoteKv(c, dependencies, c.req.valid("param")),
  );

  kv.put(
    "/:scope/:namespace/:key",
    describeRoute(writeRemoteKvRouteDescription),
    needsAuth,
    tbValidator("param", RemoteKvItemParamsSchema),
    tbValidator("json", RemoteKvWriteRequestSchema),
    (c) => handleWriteRemoteKv(c, dependencies, c.req.valid("param"), c.req.valid("json")),
  );

  kv.delete(
    "/:scope/:namespace/:key",
    describeRoute(deleteRemoteKvRouteDescription),
    needsAuth,
    tbValidator("param", RemoteKvItemParamsSchema),
    (c) => handleDeleteRemoteKv(c, dependencies, c.req.valid("param")),
  );

  return kv;
}
