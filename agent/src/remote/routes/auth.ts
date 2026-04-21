import type { MiddlewareHandler } from "hono";
import type { Static } from "@sinclair/typebox";
import { RemoteError } from "../errors.js";
import { ErrorResponseSchema } from "../schemas.js";
import { jsonWithSchema } from "../typebox.js";
import type { AuthService } from "../auth.js";
import type { RemoteHonoEnv } from "./types.js";

type ErrorResponseBody = Static<typeof ErrorResponseSchema>;
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 500;

function toErrorStatus(status: number): ErrorStatus {
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 409) {
    return status;
  }
  return 500;
}

function authError(
  c: Parameters<MiddlewareHandler<RemoteHonoEnv>>[0],
  error: unknown,
): Response & { _data: ErrorResponseBody; _status: ErrorStatus; _format: "json" } {
  if (error instanceof RemoteError) {
    return jsonWithSchema(
      c,
      ErrorResponseSchema,
      { error: error.message },
      toErrorStatus(error.status),
    );
  }
  if (error instanceof Error) {
    return jsonWithSchema(
      c,
      ErrorResponseSchema,
      { error: "Unexpected error", details: error.message },
      500,
    );
  }
  return jsonWithSchema(c, ErrorResponseSchema, { error: "Unexpected error" }, 500);
}

function requireAuth(authService: AuthService): MiddlewareHandler<RemoteHonoEnv> {
  return async (c, next) => {
    try {
      const session = authService.authenticate(c.req.header("authorization"));
      c.set("auth", session);
      await next();
    } catch (error) {
      c.res = authError(c, error);
    }
  };
}

export { authError, requireAuth };
