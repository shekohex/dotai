import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Expands `@Use` and `@Run` calls with the components and programs saved for the agent's project, so the app can draw what the agent wrote. */
export const expandRpc = defineRpc({
  name: "openui.expand",
  input: z.object({ agentId: z.string(), ui: z.string().max(2_500_000) }).strict(),
  output: z.object({ ui: z.string(), errors: z.array(z.string()) }),
});
