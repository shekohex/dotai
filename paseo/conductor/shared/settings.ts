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
      lastProjectId: z.string().default(""),
      lastNewWorktree: z.boolean().default(false),
      /** Nudge an agent whose working ticket has had no progress update for a while. */
      checkIns: z.boolean().default(true),
      checkInMinutes: z.number().int().min(5).max(120).default(15),
      /** Tell the conductor when a ticket stays blocked or stuck this long. */
      escalate: z.boolean().default(true),
      escalateMinutes: z.number().int().min(2).max(120).default(10),
    })
    .strict(),
});
