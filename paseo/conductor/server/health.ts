import { z } from "zod";

import type { NoticeReason } from "../shared/notice.js";

export const workerRecordSchema = z
  .object({
    conductorId: z.string(),
    title: z.string(),
    running: z.boolean(),
    runningSince: z.string().nullable(),
    stallReportedAt: z.string().nullable(),
    permissions: z.record(
      z.string(),
      z.object({ firstSeenAt: z.string(), reminded: z.boolean() }).strict(),
    ),
  })
  .strict();

export type WorkerRecord = z.infer<typeof workerRecordSchema>;
export type WorkerRecords = Record<string, WorkerRecord>;

export interface WorkerObservation {
  id: string;
  conductorId: string;
  title: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  updatedAt: string;
  pendingPermissionIds: readonly string[];
}

export interface PlannedNotice {
  conductorId: string;
  workerId: string;
  title: string;
  reason: NoticeReason;
  detail: string;
  messageId: string;
}

export interface HealthThresholds {
  stallMs: number;
  restallMs: number;
  permissionMs: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  stallMs: 10 * 60_000,
  restallMs: 30 * 60_000,
  permissionMs: 5 * 60_000,
};

function minutesBetween(from: string, now: number): number {
  return Math.round((now - Date.parse(from)) / 60_000);
}

function evaluatePermissions(
  observation: WorkerObservation,
  previous: WorkerRecord | undefined,
  now: number,
  thresholds: HealthThresholds,
  notices: PlannedNotice[],
): WorkerRecord["permissions"] {
  const permissions: WorkerRecord["permissions"] = {};
  for (const requestId of observation.pendingPermissionIds) {
    const seen = previous?.permissions[requestId];
    const firstSeenAt = seen?.firstSeenAt ?? new Date(now).toISOString();
    const due = now - Date.parse(firstSeenAt) >= thresholds.permissionMs;
    const reminded = (seen?.reminded ?? false) || due;
    if (due && !seen?.reminded) {
      notices.push({
        conductorId: observation.conductorId,
        workerId: observation.id,
        title: observation.title,
        reason: "still needs permission",
        detail: `Permission request ${requestId} has been pending for ${minutesBetween(firstSeenAt, now)} minutes. Answer it with respond_to_permission or ask the user.`,
        messageId: `conductor:permission:${observation.id}:${requestId}`,
      });
    }
    permissions[requestId] = { firstSeenAt, reminded };
  }
  return permissions;
}

function shouldReportStall(
  observation: WorkerObservation,
  stallReportedAt: string | null,
  now: number,
  thresholds: HealthThresholds,
): boolean {
  if (
    observation.status !== "running" ||
    observation.pendingPermissionIds.length > 0
  ) {
    return false;
  }
  if (now - Date.parse(observation.updatedAt) < thresholds.stallMs)
    return false;
  return (
    stallReportedAt === null ||
    now - Date.parse(stallReportedAt) >= thresholds.restallMs
  );
}

/**
 * Derives the next ledger and the notices the conductor has not received from Paseo itself.
 * `startup` detects turns that ended while this plugin was offline, when the daemon's in-memory
 * finish notification may have been lost.
 */
export function evaluateWorkers(input: {
  records: WorkerRecords;
  observations: readonly WorkerObservation[];
  now: number;
  startup: boolean;
  thresholds?: HealthThresholds;
}): { records: WorkerRecords; notices: PlannedNotice[] } {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const nowIso = new Date(input.now).toISOString();
  const records: WorkerRecords = {};
  const notices: PlannedNotice[] = [];

  for (const observation of input.observations) {
    const previous = input.records[observation.id];
    const running = observation.status === "running";

    if (input.startup && previous?.running && !running) {
      notices.push({
        conductorId: observation.conductorId,
        workerId: observation.id,
        title: observation.title,
        reason: "was interrupted",
        detail: `Its turn ended while the Conductor plugin was offline (daemon restart or plugin reload); current status is "${observation.status}". Paseo's finish notification may be missing. Check get_agent_activity and decide whether to resume it.`,
        messageId: `conductor:interrupted:${observation.id}:${previous.runningSince ?? "unknown"}`,
      });
    }

    let stallReportedAt = running ? (previous?.stallReportedAt ?? null) : null;
    if (
      shouldReportStall(observation, stallReportedAt, input.now, thresholds)
    ) {
      notices.push({
        conductorId: observation.conductorId,
        workerId: observation.id,
        title: observation.title,
        reason: "is stalled",
        detail: `Still running with no timeline activity for ${minutesBetween(observation.updatedAt, input.now)} minutes. Check get_agent_activity, then nudge, interrupt, or escalate.`,
        messageId: `conductor:stall:${observation.id}:${observation.updatedAt}`,
      });
      stallReportedAt = nowIso;
    }

    records[observation.id] = {
      conductorId: observation.conductorId,
      title: observation.title,
      running,
      runningSince: running
        ? ((previous?.running ? previous.runningSince : null) ?? nowIso)
        : null,
      stallReportedAt,
      permissions: evaluatePermissions(
        observation,
        previous,
        input.now,
        thresholds,
        notices,
      ),
    };
  }

  return { records, notices };
}
