import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Sentinel used by the project selector for the aggregate "all projects" view. */
export const ALL_PROJECTS_VALUE = "__all_projects__";

export const cubeSandboxSettings = defineSettings({
  id: "cubesandbox",
  scope: "host",
  version: 1,
  schema: z
    .object({
      selectedProjectId: z.string().min(1).nullable().default(null),
    })
    .strict(),
});

export type CubeSandboxSettings = z.infer<typeof cubeSandboxSettings.schema>;
