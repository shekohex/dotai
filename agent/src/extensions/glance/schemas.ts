import { Type, type Static } from "typebox";

export const GlanceStatusSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  pid: Type.Number(),
  host: Type.String(),
  port: Type.Number(),
  baseUrl: Type.String(),
  publicBaseUrl: Type.Union([Type.String(), Type.Null()]),
  storageDir: Type.String(),
  startedAt: Type.Number(),
  updatedAt: Type.Number(),
});

export type GlanceStatus = Static<typeof GlanceStatusSchema>;

export const GlanceHeartbeatSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  clientId: Type.String(),
  pid: Type.Number(),
  cwd: Type.String(),
  startedAt: Type.Number(),
  updatedAt: Type.Number(),
});

export type GlanceHeartbeat = Static<typeof GlanceHeartbeatSchema>;

export const GlanceHealthSchema = Type.Object({
  ok: Type.Literal(true),
  name: Type.Literal("pi-glance"),
  schemaVersion: Type.Literal(1),
  pid: Type.Number(),
  port: Type.Number(),
  startedAt: Type.Number(),
});

export type GlanceHealth = Static<typeof GlanceHealthSchema>;

export const GlanceConfigSchema = Type.Object({
  ok: Type.Literal(true),
  maxUploadBytes: Type.Number(),
  storageDir: Type.String(),
  supportedMimeTypes: Type.Array(Type.String()),
});

export type GlanceConfig = Static<typeof GlanceConfigSchema>;

export const GlanceUploadResponseSchema = Type.Object({
  ok: Type.Literal(true),
  id: Type.String(),
  imageUrl: Type.String(),
  path: Type.String(),
  size: Type.Number(),
  mimeType: Type.String(),
  extension: Type.String(),
  originalName: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  expiresAt: Type.String(),
});

export type GlanceUploadResponse = Static<typeof GlanceUploadResponseSchema>;

export const GlanceErrorResponseSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.String(),
});

export type GlanceErrorResponse = Static<typeof GlanceErrorResponseSchema>;
