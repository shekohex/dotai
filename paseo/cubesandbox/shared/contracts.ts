import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const workStatusSchema = z.enum([
  "creating",
  "ready",
  "busy",
  "pausing",
  "paused",
  "resuming",
  "error",
]);

export const agentReferenceSchema = z
  .object({
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export const workSummarySchema = z
  .object({
    workId: z.string().min(1),
    sandboxId: z.string().min(1),
    projectId: z.string().min(1),
    repository: z.string().min(1),
    status: workStatusSchema,
    idleTimeoutSeconds: z.number().int().positive(),
    updatedAt: z.string().datetime(),
    pausedAt: z.string().datetime().optional(),
    worktreeCount: z.number().int().nonnegative(),
    agentCount: z.number().int().nonnegative(),
    agents: z.array(agentReferenceSchema),
    previewUrls: z.array(z.string().url()),
    pairingUrl: z.string().url().optional(),
    lastError: z.string().optional(),
  })
  .strict();

const emptyInputSchema = z.object({}).strict();
const workIdInputSchema = z.object({ workId: z.string().min(1) }).strict();
const operationResultSchema = z.object({ work: workSummarySchema }).strict();

export const listWorkRpc = defineRpc({
  name: "cube.list-work",
  input: emptyInputSchema,
  output: z
    .object({ works: z.array(workSummarySchema), canInitialize: z.boolean() })
    .strict(),
});

export const initConfigRpc = defineRpc({
  name: "cube.init-config",
  input: emptyInputSchema,
  output: z.object({ path: z.string(), created: z.literal(true) }).strict(),
});

export const pauseWorkRpc = defineRpc({
  name: "cube.pause-work",
  input: workIdInputSchema,
  output: operationResultSchema,
});

export const resumeWorkRpc = defineRpc({
  name: "cube.resume-work",
  input: workIdInputSchema,
  output: operationResultSchema,
});

export const destroyWorkRpc = defineRpc({
  name: "cube.destroy-work",
  input: workIdInputSchema,
  output: z.object({ workId: z.string(), destroyed: z.literal(true) }).strict(),
});
