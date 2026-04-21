import type { MiddlewareHandler } from "hono";
import { CommandAcceptedResponseSchema } from "../schemas.js";
import type { CommandAcceptedResponse } from "../schemas.js";
import { jsonWithSchema } from "../typebox.js";
import { authError } from "./auth.js";
import type { RemoteHonoEnv } from "./types.js";

export type HonoContext = Parameters<MiddlewareHandler<RemoteHonoEnv>>[0];

export function getConnectionId(c: HonoContext): string {
  const providedConnectionId = c.req.header("x-pi-connection-id")?.trim();
  if (providedConnectionId !== undefined && providedConnectionId.length > 0) {
    return providedConnectionId;
  }
  return c.get("auth").token;
}

export function withAuthError(
  c: HonoContext,
  execute: () => Promise<Response> | Response,
): Promise<Response> {
  return Promise.resolve(execute()).catch((error: unknown) => authError(c, error));
}

export function connectionHeader(connectionId: string): Record<string, string> {
  return {
    "x-pi-connection-id": connectionId,
  };
}

export function acceptedResponse(
  c: HonoContext,
  accepted: CommandAcceptedResponse,
  connectionId: string,
): Response {
  return jsonWithSchema(
    c,
    CommandAcceptedResponseSchema,
    accepted,
    202,
    connectionHeader(connectionId),
  );
}
