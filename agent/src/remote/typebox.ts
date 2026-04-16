import type { TSchema, Static } from "@sinclair/typebox";
import type { TypeCheck } from "@sinclair/typebox/compiler";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { Context } from "hono";

const validatorCache = new WeakMap<TSchema, TypeCheck<TSchema>>();

function getValidator<T extends TSchema>(schema: T): TypeCheck<T> {
  const existing = validatorCache.get(schema);
  if (existing) {
    return existing as TypeCheck<T>;
  }
  const created = TypeCompiler.Compile(schema);
  validatorCache.set(schema, created as TypeCheck<TSchema>);
  return created;
}

export function assertType<T extends TSchema>(
  schema: T,
  value: unknown,
): asserts value is Static<T> {
  const validator = getValidator(schema);
  if (validator.Check(value)) {
    return;
  }
  const firstError = validator.Errors(value).First();
  if (firstError) {
    throw new Error(`Schema validation failed at ${firstError.path}: ${firstError.message}`);
  }
  throw new Error("Schema validation failed");
}

export function jsonWithSchema<T extends TSchema>(
  c: Context,
  schema: T,
  value: Static<T>,
  status?: 200 | 201 | 202 | 400 | 401 | 403 | 404 | 409 | 500,
  headers?: HeadersInit,
): Response {
  assertType(schema, value);
  if (headers) {
    return new Response(JSON.stringify(value), {
      status: status ?? 200,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
    });
  }
  if (status) {
    return c.json(value, status);
  }
  return c.json(value);
}
