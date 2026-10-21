import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const prismSettings = defineSettings({
  id: "prism",
  scope: "host",
  version: 1,
  schema: z
    .object({
      /** Web and desktop only: hide the built-in panels and chip that Prism replaces. */
      hideBuiltinPanels: z.boolean().default(true),
      /** Highlights theme for code in diffs; "auto" matches the Paseo theme. */
      syntaxTheme: z.string().default("auto"),
    })
    .strict(),
});
