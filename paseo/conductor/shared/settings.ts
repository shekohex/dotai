import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const conductorSettings = defineSettings({
  id: "conductor",
  scope: "host",
  version: 1,
  schema: z
    .object({
      lastProvider: z.string().default(""),
      lastModel: z.string().default(""),
      lastThinkingOptionId: z.string().default(""),
      lastWorkspaceId: z.string().default(""),
    })
    .strict(),
});
