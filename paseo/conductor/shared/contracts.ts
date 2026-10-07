import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const createConductorRpc = defineRpc({
  name: "conductor.create",
  input: z
    .object({
      workspaceId: z.string().min(1),
      provider: z.string().min(1),
      model: z.string().optional(),
      thinkingOptionId: z.string().optional(),
      title: z.string().min(1),
      prompt: z.string().optional(),
    })
    .strict(),
  output: z.object({ agentId: z.string() }).strict(),
});

export const MEMORY_FILE_NAME = /^[A-Za-z0-9][\w.-]*\.md$/;

/** Addresses one editable document: conductor memory, global memory, or a project's CONDUCTOR.md. */
export const documentRefSchema = z.discriminatedUnion("scope", [
  z
    .object({
      scope: z.literal("conductor"),
      conductorId: z.string().regex(/^[\w-]+$/),
      name: z.string().regex(MEMORY_FILE_NAME),
    })
    .strict(),
  z
    .object({
      scope: z.literal("global"),
      name: z.string().regex(MEMORY_FILE_NAME),
    })
    .strict(),
  z
    .object({ scope: z.literal("project"), workspaceId: z.string().min(1) })
    .strict(),
]);

export type DocumentRef = z.infer<typeof documentRefSchema>;

export const documentSchema = z
  .object({
    ref: documentRefSchema,
    name: z.string(),
    path: z.string(),
    /** null when the file does not exist yet (only CONDUCTOR.md). */
    content: z.string().nullable(),
    core: z.boolean(),
  })
  .strict();

export type ConductorDocument = z.infer<typeof documentSchema>;

export const listDocumentsRpc = defineRpc({
  name: "conductor.documents.list",
  input: z
    .object({
      conductorId: z.string().min(1).optional(),
      workspaceId: z.string().min(1).optional(),
    })
    .strict(),
  output: z
    .object({
      conductor: z.array(documentSchema),
      global: z.array(documentSchema),
      project: documentSchema.nullable(),
    })
    .strict(),
});

export const writeDocumentRpc = defineRpc({
  name: "conductor.documents.write",
  input: z
    .object({
      ref: documentRefSchema,
      /** null deletes the file. */
      content: z.string().nullable(),
      /** Content the editor started from; the write fails if the file changed since. */
      previousContent: z.string().nullable(),
      /** Tells this conductor to re-read the file. */
      notifyConductorId: z.string().min(1).optional(),
    })
    .strict(),
  output: z.object({ path: z.string() }).strict(),
});
