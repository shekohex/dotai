import { Type } from "typebox";

export const RemoteKvScopeSchema = Type.Union([Type.Literal("global"), Type.Literal("user")]);

export const RemoteKvItemParamsSchema = Type.Object({
  scope: RemoteKvScopeSchema,
  namespace: Type.String({ minLength: 1 }),
  key: Type.String({ minLength: 1 }),
});

export const RemoteKvWriteRequestSchema = Type.Object({
  value: Type.Unknown(),
});

export const RemoteKvReadResponseSchema = Type.Object({
  scope: RemoteKvScopeSchema,
  namespace: Type.String(),
  key: Type.String(),
  found: Type.Boolean(),
  value: Type.Optional(Type.Unknown()),
  updatedAt: Type.Optional(Type.Number()),
});

export const RemoteKvWriteResponseSchema = Type.Object({
  scope: RemoteKvScopeSchema,
  namespace: Type.String(),
  key: Type.String(),
  value: Type.Unknown(),
  updatedAt: Type.Number(),
});

export const RemoteKvDeleteResponseSchema = Type.Object({
  scope: RemoteKvScopeSchema,
  namespace: Type.String(),
  key: Type.String(),
  deleted: Type.Boolean(),
  updatedAt: Type.Optional(Type.Number()),
});
