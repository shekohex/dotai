import type { TSchema, Static } from "typebox";
import type { Validator } from "typebox/compile";
import { Compile } from "typebox/compile";
import type { Context, TypedResponse } from "hono";

type JsonResponseStatus = 200 | 201 | 202 | 400 | 401 | 403 | 404 | 409 | 500;
type JsonResponseHeaders = Record<string, string | string[]>;

function getValidator<T extends TSchema>(schema: T): Validator<Record<string, never>, T> {
  return Compile(schema);
}

export function assertType<T extends TSchema>(
  schema: T,
  value: unknown,
): asserts value is Static<T> {
  const validator = getValidator(schema);
  if (validator.Check(value)) {
    return;
  }
  const firstError = validator.Errors(value)[0];
  if (firstError !== undefined) {
    throw new Error(
      `Schema validation failed at ${firstError.instancePath || "/"}: ${firstError.message}`,
    );
  }
  throw new Error("Schema validation failed");
}

export function jsonWithSchema<T extends TSchema>(
  c: Context,
  schema: T,
  value: Static<T>,
): Response & TypedResponse<Static<T>, 200, "json">;
export function jsonWithSchema<T extends TSchema, TStatus extends JsonResponseStatus>(
  c: Context,
  schema: T,
  value: Static<T>,
  status: TStatus,
  headers?: JsonResponseHeaders,
): Response & TypedResponse<Static<T>, TStatus, "json">;
export function jsonWithSchema<T extends TSchema>(
  c: Context,
  schema: T,
  value: Static<T>,
  status?: JsonResponseStatus,
  headers?: JsonResponseHeaders,
): Response {
  assertType(schema, value);
  if (status === undefined) {
    return c.json(value, 200, headers);
  }
  return c.json(value, status, headers);
}
