import type { z } from "zod";

import type { workSummarySchema } from "../shared/contracts.js";

export type WorkSummaryView = z.infer<typeof workSummarySchema>;

export function primaryLifecycleAction(
  status: WorkSummaryView["status"],
): "pause" | "resume" | null {
  if (status === "paused") return "resume";
  if (status === "ready" || status === "busy") return "pause";
  return null;
}

export function idleLabel(work: WorkSummaryView, now = Date.now()): string {
  if (work.status === "paused") return "Paused";
  if (work.status === "busy") return "Keepalive active";
  const idleSeconds = Math.max(
    0,
    Math.floor((now - Date.parse(work.updatedAt)) / 1_000),
  );
  const graceRemaining = Math.max(0, work.idleTimeoutSeconds - idleSeconds);
  return graceRemaining > 0
    ? `Idle pause in ${Math.ceil(graceRemaining / 60)}m`
    : "Idle pause pending";
}
