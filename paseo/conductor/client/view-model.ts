export interface WorkerView {
  id: string;
  title: string | null;
  provider: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  updatedAt: string;
  attentionReason?: "finished" | "error" | "permission" | null;
  pendingPermissions: readonly unknown[];
}

export type WorkerGroupId =
  "needs-you" | "working" | "errored" | "idle" | "closed";

export interface WorkerGroup {
  id: WorkerGroupId;
  title: string;
  workers: WorkerView[];
}

const GROUP_TITLES: Record<WorkerGroupId, string> = {
  "needs-you": "Needs you",
  working: "Working",
  errored: "Errored",
  idle: "Idle / done",
  closed: "Closed",
};

export function workerGroupId(worker: WorkerView): WorkerGroupId {
  if (
    worker.pendingPermissions.length > 0 ||
    worker.attentionReason === "permission"
  ) {
    return "needs-you";
  }
  if (worker.status === "running" || worker.status === "initializing")
    return "working";
  if (worker.status === "error" || worker.attentionReason === "error")
    return "errored";
  if (worker.status === "closed") return "closed";
  return "idle";
}

export function groupWorkers(workers: readonly WorkerView[]): WorkerGroup[] {
  const sorted = [...workers].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  return (Object.keys(GROUP_TITLES) as WorkerGroupId[])
    .map((id) => ({
      id,
      title: GROUP_TITLES[id],
      workers: sorted.filter((worker) => workerGroupId(worker) === id),
    }))
    .filter((group) => group.workers.length > 0);
}

export function countNeedingAttention(workers: readonly WorkerView[]): number {
  return workers.filter((worker) => {
    const group = workerGroupId(worker);
    return group === "needs-you" || group === "errored";
  }).length;
}

export function relativeTime(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
