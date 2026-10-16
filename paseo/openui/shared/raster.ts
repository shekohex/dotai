import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Vector sources the daemon turns into a PNG, since plugins have no SVG view to draw them with. */
export const RASTER_KINDS = ["svg", "latex", "dot", "qr"] as const;
export const RASTER_MAX_SOURCE = 200_000;

export const rasterRpc = defineRpc({
  name: "openui.raster",
  input: z
    .object({
      kind: z.enum(RASTER_KINDS),
      source: z.string().min(1).max(RASTER_MAX_SOURCE),
      /** LaTeX only: set as a block (true) or inline (false). */
      display: z.boolean().optional(),
      /** Theme foreground; stands in for currentColor and for default black. */
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      scale: z.number().min(1).max(4),
      maxWidth: z.number().min(40).max(2000),
    })
    .strict(),
  output: z.object({ data: z.string(), width: z.number(), height: z.number() }),
});
