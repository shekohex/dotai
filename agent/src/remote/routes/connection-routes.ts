import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { tbValidator } from "@hono/typebox-validator";
import { describeRoute } from "hono-openapi";
import { ClientCapabilitiesSchema, ConnectionCapabilitiesParamsSchema } from "../schemas.js";
import { updateConnectionCapabilitiesRouteDescription } from "./descriptions.js";
import { handleUpdateConnectionCapabilities } from "./handlers.js";
import type { RemoteHonoEnv, RemoteRoutesDependencies } from "./types.js";

export function createConnectionRoutes(
  dependencies: RemoteRoutesDependencies,
  needsAuth: MiddlewareHandler<RemoteHonoEnv>,
): Hono<RemoteHonoEnv> {
  const connections = new Hono<RemoteHonoEnv>();

  connections.post(
    "/:connectionId/capabilities",
    describeRoute(updateConnectionCapabilitiesRouteDescription),
    needsAuth,
    tbValidator("param", ConnectionCapabilitiesParamsSchema),
    tbValidator("json", ClientCapabilitiesSchema),
    (c) => {
      const { connectionId } = c.req.valid("param");
      return handleUpdateConnectionCapabilities(c, dependencies, connectionId, c.req.valid("json"));
    },
  );

  return connections;
}
