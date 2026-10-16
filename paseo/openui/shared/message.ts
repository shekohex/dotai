import { z } from "zod";
import { type FenceSegment, splitFences } from "./fence";

/** An assistant message that contains ```openui blocks, split into prose and programs. */
export const messageSchema = z.object({
  segments: z.array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), text: z.string() }),
      z.object({ kind: z.literal("ui"), ui: z.string(), title: z.string().optional(), complete: z.boolean() }),
    ]),
  ),
});

export type MessageData = z.infer<typeof messageSchema>;

/** A block still open when the message is complete was just left unclosed; draw it as finished. */
export function messageData(text: string, phase: "streaming" | "complete"): MessageData {
  const segments: FenceSegment[] = splitFences(text).map((segment) =>
    segment.kind === "ui" && phase === "complete" ? { ...segment, complete: true } : segment,
  );
  return { segments };
}
