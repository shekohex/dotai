import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PhaseSnapshot } from "./read.js";

export const statsPhaseStatuses = [
  "Not Started",
  "In Progress",
  "Executed",
  "Human Needed",
  "Complete",
] as const;

export type StatsPhaseStatus = (typeof statsPhaseStatuses)[number];

type ParsedRequirement = {
  id: string;
  complete: boolean;
};

type VerificationStatus = "passed" | "gaps_found" | "human_needed" | undefined;

type UatStatus = "testing" | "partial" | "complete" | "diagnosed" | undefined;

export function readGitCommitCount(cwd: string): number | null {
  try {
    const stdout = execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const count = Number.parseInt(stdout, 10);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

export function readGitFirstCommitDate(cwd: string): string | null {
  try {
    return (
      execFileSync("git", ["log", "--reverse", "--format=%cI", "HEAD"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? null
    );
  } catch {
    return null;
  }
}

export function readLatestPlanningActivity(cwd: string): string | null {
  const planningDir = join(cwd, ".planning");
  if (!existsSync(planningDir)) {
    return null;
  }

  let latestTimestamp = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const modified = statSync(path).mtimeMs;
      if (modified > latestTimestamp) {
        latestTimestamp = modified;
      }
    }
  };

  visit(planningDir);
  return latestTimestamp > 0 ? new Date(latestTimestamp).toISOString() : null;
}

export function canonicalizePhaseNumber(value: string): string {
  return value
    .trim()
    .split(".")
    .map((segment) => String(Number.parseInt(segment, 10)))
    .join(".");
}

function isCanonicalPhaseArtifact(fileName: string, phaseNumber: string, suffix: string): boolean {
  const artifactPrefix = fileName.replace(suffix, "");
  return canonicalizePhaseNumber(artifactPrefix) === canonicalizePhaseNumber(phaseNumber);
}

export function filterCanonicalPhaseArtifacts(
  fileNames: string[],
  phaseNumber: string | undefined,
  suffix: string,
): string[] {
  if (phaseNumber === undefined) {
    return [];
  }

  return fileNames.filter((candidate) => isCanonicalPhaseArtifact(candidate, phaseNumber, suffix));
}

export function extractLeadingPhaseNumber(value: string): string {
  const match = value.match(/^(\d+(?:\.\d+)?)/u);
  return canonicalizePhaseNumber(match?.[1] ?? value);
}

export function parseRequirementsProgress(content: string | undefined): {
  total: number;
  complete: number;
} {
  if (content === undefined || content.trim().length === 0) {
    return { total: 0, complete: 0 };
  }

  const requirements = new Map<string, ParsedRequirement>();
  const lines = content.split("\n");
  const deferredRequirementIds = new Set<string>();
  collectDeferredRequirementIds(lines, deferredRequirementIds);

  let currentVersion: string | undefined;
  let sawVersionHeading = false;
  let insideTraceability = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const versionHeading = line.match(/^##+\s+(v\d+(?:\.\d+){0,2})\b/iu);
    if (versionHeading?.[1] !== undefined) {
      currentVersion = versionHeading[1].toLowerCase();
      sawVersionHeading = true;
      insideTraceability = false;
      continue;
    }

    if (/^##+\s+Traceability\b/iu.test(line)) {
      insideTraceability = true;
      continue;
    }

    if (/^##+\s+/u.test(line)) {
      insideTraceability = false;
    }

    if (insideTraceability && line.startsWith("|")) {
      const parsed = parseTraceabilityRow(line);
      if (parsed !== undefined && !deferredRequirementIds.has(parsed.id)) {
        requirements.set(parsed.id, parsed);
      }
      continue;
    }

    if (sawVersionHeading && isDeferredRequirementsVersion(currentVersion)) {
      continue;
    }

    const parsed = parseRequirementBullet(line);
    if (parsed !== undefined) {
      const existing = requirements.get(parsed.id);
      requirements.set(parsed.id, {
        id: parsed.id,
        complete: parsed.complete || existing?.complete === true,
      });
    }
  }

  const complete = [...requirements.values()].filter((requirement) => requirement.complete).length;
  return {
    total: requirements.size,
    complete,
  };
}

function collectDeferredRequirementIds(lines: string[], deferredRequirementIds: Set<string>): void {
  let currentVersion: string | undefined;
  let sawVersionHeading = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const versionHeading = line.match(/^##+\s+(v\d+(?:\.\d+){0,2})\b/iu);
    if (versionHeading?.[1] !== undefined) {
      currentVersion = versionHeading[1].toLowerCase();
      sawVersionHeading = true;
      continue;
    }

    if (!sawVersionHeading || !isDeferredRequirementsVersion(currentVersion)) {
      continue;
    }

    const parsed = parseRequirementBullet(line);
    if (parsed !== undefined) {
      deferredRequirementIds.add(parsed.id);
    }
  }
}

function isDeferredRequirementsVersion(version: string | undefined): boolean {
  if (version === undefined) {
    return false;
  }
  const match = version.match(/^v(\d+)/iu);
  if (match?.[1] === undefined) {
    return false;
  }
  return Number.parseInt(match[1], 10) >= 2;
}

export function deriveStatsPhaseStatus(
  phaseSnapshot: PhaseSnapshot | undefined,
  roadmapPlanCount: number,
): StatsPhaseStatus {
  const phaseNumber =
    phaseSnapshot === undefined ? undefined : extractLeadingPhaseNumber(phaseSnapshot.id);
  const planCount = Math.max(roadmapPlanCount, phaseSnapshot?.plans.length ?? 0);
  const summaryCount = phaseSnapshot?.summaries.length ?? 0;

  if (planCount === 0 && phaseSnapshot === undefined) {
    return "Not Started";
  }

  if (summaryCount === 0) {
    return phaseHasAnyLocalExecutionArtifact(phaseSnapshot) ? "In Progress" : "Not Started";
  }

  if (summaryCount < planCount) {
    return "In Progress";
  }

  const verificationStatus = readLatestVerificationStatus(phaseSnapshot);
  if (verificationStatus === "human_needed") {
    return "Human Needed";
  }
  if (verificationStatus === "passed") {
    return "Complete";
  }

  const uatStatus = readLatestUatStatus(phaseSnapshot, phaseNumber);
  if (uatStatus === "complete") {
    return "Complete";
  }

  return "Executed";
}

function phaseHasAnyLocalExecutionArtifact(phaseSnapshot: PhaseSnapshot | undefined): boolean {
  return (
    phaseSnapshot !== undefined &&
    phaseSnapshot.plans.length +
      phaseSnapshot.summaries.length +
      phaseSnapshot.verifications.length +
      phaseSnapshot.validations.length +
      phaseSnapshot.uats.length >
      0
  );
}

function parseRequirementBullet(line: string): ParsedRequirement | undefined {
  const checklistMatch = line.match(
    /^-\s+\[([ xX])\]\s+(?:\*\*)?([A-Z][A-Z0-9]+-\d+(?:\.\d+)?)(?:\*\*)?(?::|\b)/u,
  );
  if (checklistMatch?.[2] !== undefined) {
    return {
      id: checklistMatch[2],
      complete: checklistMatch[1]?.toLowerCase() === "x",
    };
  }

  const bulletMatch = line.match(/^-\s+(?:\*\*)?([A-Z][A-Z0-9]+-\d+(?:\.\d+)?)(?:\*\*)?(?::|\b)/u);
  if (bulletMatch?.[1] === undefined) {
    return undefined;
  }

  return {
    id: bulletMatch[1],
    complete: false,
  };
}

function parseTraceabilityRow(line: string): ParsedRequirement | undefined {
  const columns = line
    .split("|")
    .map((column) => column.trim())
    .filter((column) => column.length > 0);
  if (columns.length < 3) {
    return undefined;
  }
  const idMatch = columns[0]?.match(/^([A-Z][A-Z0-9]+-\d+(?:\.\d+)?)$/u);
  if (idMatch?.[1] === undefined) {
    return undefined;
  }
  const status = columns[2]?.toLowerCase() ?? "";
  return {
    id: idMatch[1],
    complete: /(complete|completed|verified|passed)/u.test(status),
  };
}

function readLatestVerificationStatus(
  phaseSnapshot: PhaseSnapshot | undefined,
): VerificationStatus {
  const phaseNumber =
    phaseSnapshot === undefined ? undefined : extractLeadingPhaseNumber(phaseSnapshot.id);
  const fileName = filterCanonicalPhaseArtifacts(
    phaseSnapshot?.verifications ?? [],
    phaseNumber,
    "-VERIFICATION.md",
  )
    .toSorted((left, right) => left.localeCompare(right))
    .at(-1);
  if (phaseSnapshot === undefined || fileName === undefined) {
    return undefined;
  }
  const content = readPhaseFile(phaseSnapshot.path, fileName);
  if (content === undefined) {
    return undefined;
  }
  const frontmatter = readFrontmatter(content);
  const statusMatch = frontmatter
    .match(/^status:\s*(.+)$/mu)?.[1]
    ?.trim()
    .toLowerCase();
  if (
    statusMatch === "passed" ||
    statusMatch === "approved" ||
    statusMatch === "complete" ||
    statusMatch === "ready_for_closeout" ||
    statusMatch === "ready_for_metadata_closeout"
  ) {
    return "passed";
  }
  if (statusMatch === "gaps_found" || statusMatch === "human_needed") {
    return statusMatch;
  }
  const verifiedMatch = frontmatter
    .match(/^verified:\s*(.+)$/mu)?.[1]
    ?.trim()
    .toLowerCase();
  if (verifiedMatch === "true" || verifiedMatch === "passed" || verifiedMatch === "approved") {
    return "passed";
  }
  if (verifiedMatch === "false") {
    return "gaps_found";
  }
  return undefined;
}

function readLatestUatStatus(
  phaseSnapshot: PhaseSnapshot | undefined,
  phaseNumber: string | undefined,
): UatStatus {
  const fileName = filterCanonicalPhaseArtifacts(phaseSnapshot?.uats ?? [], phaseNumber, "-UAT.md")
    .toSorted((left, right) => left.localeCompare(right))
    .at(-1);
  if (phaseSnapshot === undefined || fileName === undefined) {
    return undefined;
  }
  const content = readPhaseFile(phaseSnapshot.path, fileName);
  if (content === undefined) {
    return undefined;
  }
  const frontmatter = readFrontmatter(content);
  const status = frontmatter.match(/^status:\s*(.+)$/mu)?.[1]?.trim();
  if (
    status === "testing" ||
    status === "partial" ||
    status === "complete" ||
    status === "diagnosed"
  ) {
    return status;
  }
  return undefined;
}

function readPhaseFile(phasePath: string, fileName: string): string | undefined {
  const path = join(phasePath, fileName);
  if (!existsSync(path)) {
    return undefined;
  }
  return readFileSync(path, "utf8");
}

function readFrontmatter(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---/u);
  return match?.[1] ?? "";
}
