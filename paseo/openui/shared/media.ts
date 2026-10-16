import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** An image the agent named by path, read by the daemon and returned inline for the app to draw. */
export const imageRpc = defineRpc({
  name: "openui.image",
  input: z.object({ agentId: z.string(), path: z.string().min(1) }).strict(),
  output: z.object({ mime: z.string(), data: z.string() }),
});

/** Any other file the agent named: served by the daemon and opened in the browser. */
export const shareRpc = defineRpc({
  name: "openui.share",
  input: z.object({ agentId: z.string(), path: z.string().min(1) }).strict(),
  output: z.object({ url: z.string() }),
});
