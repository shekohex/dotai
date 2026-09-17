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
    paseoProjectId: z.string().min(1),
    cubeProjectId: z.string().min(1),
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
    quarantined: z.boolean().optional(),
  })
  .strict();

export const projectAvailabilitySchema = z.enum([
  "online",
  "offline",
  "removed",
]);
export const projectConfigStatusSchema = z.enum([
  "ready",
  "missing",
  "invalid",
  "unavailable",
]);

export const cubeProjectCountsSchema = z
  .object({
    work: z.number().int().nonnegative(),
    busy: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
  })
  .strict();

export const cubeProjectSummarySchema = z
  .object({
    projectId: z.string().min(1),
    displayName: z.string().min(1),
    availability: projectAvailabilitySchema,
    configStatus: projectConfigStatusSchema,
    cubeProjectId: z.string().min(1).optional(),
    repository: z.string().min(1).optional(),
    canonicalRoot: z.string().min(1).optional(),
    configError: z.string().min(1).optional(),
    counts: cubeProjectCountsSchema,
    works: z.array(workSummarySchema),
  })
  .strict();

const emptyInputSchema = z.object({}).strict();
const projectWorkInputSchema = z
  .object({ projectId: z.string().min(1), workId: z.string().min(1) })
  .strict();
const operationResultSchema = z.object({ work: workSummarySchema }).strict();

export const listProjectsRpc = defineRpc({
  name: "cube.list-projects",
  input: emptyInputSchema,
  output: z.object({ projects: z.array(cubeProjectSummarySchema) }).strict(),
});

export const initConfigRpc = defineRpc({
  name: "cube.init-config",
  input: z.object({ projectId: z.string().min(1) }).strict(),
  output: z.object({ path: z.string(), created: z.literal(true) }).strict(),
});

export const pauseWorkRpc = defineRpc({
  name: "cube.pause-work",
  input: projectWorkInputSchema,
  output: operationResultSchema,
});

export const resumeWorkRpc = defineRpc({
  name: "cube.resume-work",
  input: projectWorkInputSchema,
  output: operationResultSchema,
});

export const destroyWorkRpc = defineRpc({
  name: "cube.destroy-work",
  input: projectWorkInputSchema,
  output: z.object({ workId: z.string(), destroyed: z.literal(true) }).strict(),
});
