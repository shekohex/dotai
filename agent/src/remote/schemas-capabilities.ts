import { Type } from "typebox";

export const ClientCapabilitiesPrimitivesSchema = Type.Object({
  select: Type.Boolean(),
  confirm: Type.Boolean(),
  input: Type.Boolean(),
  editor: Type.Boolean(),
  custom: Type.Boolean(),
  setWidget: Type.Boolean(),
  setHeader: Type.Boolean(),
  setFooter: Type.Boolean(),
  setEditorComponent: Type.Boolean(),
  onTerminalInput: Type.Boolean(),
});

export const ClientCapabilitiesSchema = Type.Object({
  protocolVersion: Type.Literal("1.0"),
  primitives: ClientCapabilitiesPrimitivesSchema,
});

export const RemoteExtensionRuntimeSchema = Type.Union([
  Type.Literal("server"),
  Type.Literal("client"),
]);

export const RemoteExtensionMetadataSchema = Type.Object({
  id: Type.String(),
  runtime: RemoteExtensionRuntimeSchema,
  path: Type.String(),
});

export const ConnectionCapabilitiesParamsSchema = Type.Object({
  connectionId: Type.String({ minLength: 1 }),
});

export const ConnectionCapabilitiesResponseSchema = Type.Object({
  connectionId: Type.String(),
  updatedAt: Type.Number(),
});
