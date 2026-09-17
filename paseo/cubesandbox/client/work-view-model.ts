import type { z } from "zod";

import type {
  cubeProjectSummarySchema,
  workSummarySchema,
} from "../shared/contracts.js";

export type WorkSummaryView = z.infer<typeof workSummarySchema>;
export type CubeProjectSummaryView = z.infer<typeof cubeProjectSummarySchema>;

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

/** Returns the persisted selection when it still maps to a live project, else null. */
export function resolveSelectedProjectId(
  projects: readonly CubeProjectSummaryView[],
  selectedProjectId: string | null,
): string | null {
  if (
    selectedProjectId &&
    projects.some((project) => project.projectId === selectedProjectId)
  ) {
    return selectedProjectId;
  }
  return null;
}

export function visibleProjects(
  projects: readonly CubeProjectSummaryView[],
  selectedProjectId: string | null,
): CubeProjectSummaryView[] {
  const selected = resolveSelectedProjectId(projects, selectedProjectId);
  return selected
    ? projects.filter((project) => project.projectId === selected)
    : [...projects];
}

/** An enabled "initialize configuration" action requires an online, unconfigured project. */
export function canInitializeProject(project: CubeProjectSummaryView): boolean {
  return (
    project.availability === "online" && project.configStatus === "missing"
  );
}

/** Work lifecycle mutations require an online project root. */
export function canManageProjectWork(project: CubeProjectSummaryView): boolean {
  return project.availability === "online";
}

export function projectReadinessLabel(project: CubeProjectSummaryView): string {
  switch (project.configStatus) {
    case "ready":
      return "Configuration ready";
    case "missing":
      return "Configuration missing";
    case "invalid":
      return "Configuration invalid";
    case "unavailable":
      return "Unavailable";
  }
}

export function projectAvailabilityLabel(
  project: CubeProjectSummaryView,
): string | null {
  if (project.availability === "online") return null;
  if (project.availability === "removed") return "Project removed";
  return "Project unavailable";
}

export function projectIdentityLabel(project: CubeProjectSummaryView): string {
  const identity = [project.repository, project.cubeProjectId].filter(
    (value): value is string => Boolean(value),
  );
  if (identity.length > 0) return identity.join(" · ");
  return project.canonicalRoot ?? "";
}

export function projectCountsLabel(project: CubeProjectSummaryView): string {
  const { work, busy, paused } = project.counts;
  return `${work} work · ${busy} busy · ${paused} paused`;
}
