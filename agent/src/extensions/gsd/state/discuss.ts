import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { GsdCommandArgs } from "../args.js";
import { resolvePlanningDir } from "../shared.js";
import { readPlanningConfig, readPlanningSnapshot } from "./read.js";
import {
  DiscussCheckpointSchema,
  DiscussDraftSchema,
  type DiscussCheckpoint,
  type DiscussDraft,
  type PlanningConfig,
} from "./schema.js";

export type DiscussMode = "discuss" | "assumptions";
export type DiscussRoute = "default-discuss" | "assumptions-preview" | "assumptions-artifact";

const checkpointFileName = "DISCUSS-CHECKPOINT.json";
const boundedSummaryLimit = 3;
const boundedLineLimit = 12;

const scoutDocNames = [
  "STACK.md",
  "INTEGRATIONS.md",
  "ARCHITECTURE.md",
  "STRUCTURE.md",
  "CONVENTIONS.md",
  "TESTING.md",
  "CONCERNS.md",
] as const;

function parsePhaseNumber(value: string): number {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : Number.NaN;
}

function comparePhaseIdsDescending(left: string, right: string): number {
  const leftPhase = parsePhaseNumber(left.split("-")[0] ?? "");
  const rightPhase = parsePhaseNumber(right.split("-")[0] ?? "");
  if (Number.isNaN(leftPhase) || Number.isNaN(rightPhase)) {
    return right.localeCompare(left);
  }
  return rightPhase - leftPhase;
}

export function resolveDiscussMode(
  config: PlanningConfig | undefined,
  _args: GsdCommandArgs,
): DiscussMode {
  return config?.workflow?.discuss_mode === "assumptions" ? "assumptions" : "discuss";
}

export function resolveDiscussRoute(
  config: PlanningConfig | undefined,
  args: GsdCommandArgs,
): DiscussRoute {
  if (args.assumptions === true) {
    return "assumptions-preview";
  }
  return config?.workflow?.discuss_mode === "assumptions"
    ? "assumptions-artifact"
    : "default-discuss";
}

export function createEmptyDiscussDraft(phaseBoundary: string): DiscussDraft {
  return {
    phaseBoundary,
    implementationDecisions: [],
    discretionAreas: [],
    canonicalReferences: [],
    existingCodeInsights: [],
    specificIdeas: [],
    deferredIdeas: [],
    discussionLog: [],
  };
}

export function loadPriorDiscussContext(cwd: string, phase: string): string {
  const planningDir = resolvePlanningDir(cwd);
  const decisionsIndexPath = join(planningDir, "DECISIONS-INDEX.md");
  if (existsSync(decisionsIndexPath)) {
    return summarizeMarkdown(
      ".planning/DECISIONS-INDEX.md",
      readFileSync(decisionsIndexPath, "utf8"),
    );
  }

  const snapshot = readPlanningSnapshot(cwd);
  const currentPhase = parsePhaseNumber(phase);
  const priorContexts = snapshot.phases
    .filter((entry) => entry.context !== undefined)
    .filter((entry) => {
      const entryPhase = parsePhaseNumber(entry.id.split("-")[0] ?? "");
      if (Number.isNaN(currentPhase) || Number.isNaN(entryPhase)) {
        return false;
      }
      return entryPhase < currentPhase;
    })
    .toSorted((left, right) => comparePhaseIdsDescending(left.id, right.id))
    .slice(0, boundedSummaryLimit)
    .map((entry) => summarizeMarkdown(entry.id, entry.context ?? ""));
  if (priorContexts.length === 0) {
    return "No prior discuss context.";
  }
  return priorContexts.join("\n\n");
}

export function scoutDiscussCodebase(cwd: string, phase: string): string {
  const planningDir = resolvePlanningDir(cwd);
  const roadmapPath = join(planningDir, "ROADMAP.md");
  const roadmapContent = existsSync(roadmapPath) ? readFileSync(roadmapPath, "utf8") : undefined;
  const roadmapSummary =
    roadmapContent === undefined
      ? "ROADMAP.md missing."
      : summarizeMarkdown(`ROADMAP phase ${phase}`, roadmapContent);
  const codebaseDir = join(planningDir, "codebase");
  if (existsSync(codebaseDir)) {
    const selectedDocNames = selectScoutDocNames(roadmapContent, phase);
    const files = selectedDocNames
      .map((name) => join(codebaseDir, name))
      .filter((path) => existsSync(path))
      .map((path) => summarizeMarkdown(path.replace(`${cwd}/`, ""), readFileSync(path, "utf8")));
    return [roadmapSummary, ...files].join("\n\n");
  }
  return `${roadmapSummary}\n\nNo canonical codebase map found.`;
}

function selectScoutDocNames(roadmapContent: string | undefined, phase: string): string[] {
  const lower = roadmapContent?.toLowerCase() ?? "";
  const phaseNeedle = `phase ${phase}:`;
  const phaseIndex = lower.indexOf(phaseNeedle);
  const phaseWindow = phaseIndex === -1 ? lower : lower.slice(phaseIndex, phaseIndex + 600);
  const names = new Set<string>();

  const addMany = (values: readonly string[]) => {
    for (const value of values) {
      names.add(value);
      if (names.size >= 3) {
        return;
      }
    }
  };

  if (/(test|quality|lint|verify|validation|debug|stability)/u.test(phaseWindow)) {
    addMany(["TESTING.md", "CONVENTIONS.md", "CONCERNS.md"]);
  }
  if (/(ui|frontend|screen|layout|component|design)/u.test(phaseWindow)) {
    addMany(["STRUCTURE.md", "ARCHITECTURE.md", "CONVENTIONS.md"]);
  }
  if (/(api|backend|service|integration|database|auth)/u.test(phaseWindow)) {
    addMany(["STACK.md", "INTEGRATIONS.md", "ARCHITECTURE.md"]);
  }
  if (names.size === 0) {
    addMany(["STACK.md", "INTEGRATIONS.md", "ARCHITECTURE.md"]);
  }
  addMany(scoutDocNames);
  return [...names].slice(0, 3);
}

export function readDiscussBlockingResumeFile(phaseDir: string): string | undefined {
  const fileName = ".continue-here.md";
  const path = join(phaseDir, fileName);
  if (!existsSync(path)) {
    return undefined;
  }

  const content = readFileSync(path, "utf8");
  return hasBlockingResumeRows(content) ? fileName : undefined;
}

function hasBlockingResumeRows(content: string): boolean {
  const lines = content.split(/\r?\n/u);
  let inBlockingTable = false;
  let inAntiPatternsTable = false;
  let antiPatternSeverityIndex = -1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+Critical Anti-Patterns/u.test(trimmed)) {
      inAntiPatternsTable = false;
      antiPatternSeverityIndex = -1;
      continue;
    }
    if (!trimmed.startsWith("|")) {
      inBlockingTable = false;
      inAntiPatternsTable = false;
      continue;
    }
    const columns = trimmed
      .split("|")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (columns.length < 3) {
      continue;
    }
    if (
      columns[0] === "Requirement" &&
      columns[1] === "Status" &&
      columns[2] === "Blocking Issue"
    ) {
      inBlockingTable = true;
      inAntiPatternsTable = false;
      antiPatternSeverityIndex = -1;
      continue;
    }
    if (columns.some((value) => value.toLowerCase() === "severity")) {
      antiPatternSeverityIndex = columns.findIndex((value) => value.toLowerCase() === "severity");
      inAntiPatternsTable = antiPatternSeverityIndex >= 0;
      inBlockingTable = false;
      continue;
    }
    if (columns.every((value) => /^:?-+:?$/u.test(value))) {
      continue;
    }
    if (inAntiPatternsTable && antiPatternSeverityIndex >= 0) {
      const severity = columns[antiPatternSeverityIndex]?.toLowerCase();
      if (severity === "blocking") {
        return true;
      }
    }
    if (!inBlockingTable) {
      continue;
    }
    const blockingIssue = columns[2];
    if (blockingIssue !== undefined && blockingIssue.toLowerCase() !== "none") {
      return true;
    }
  }
  return false;
}

function summarizeMarkdown(label: string, content: string): string {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("---"))
    .slice(0, boundedLineLimit);
  return [`${label}:`, ...lines].join("\n");
}

export function extractPhaseCanonicalReferences(
  cwd: string,
  phase: string,
): Array<{ path: string; reason: string }> {
  const planningDir = resolvePlanningDir(cwd);
  const roadmapPath = join(planningDir, "ROADMAP.md");
  const references: Array<{ path: string; reason: string }> = [];

  if (existsSync(roadmapPath)) {
    const roadmapContent = readFileSync(roadmapPath, "utf8");
    const phaseSection = readRoadmapPhaseSection(roadmapContent, phase);
    if (phaseSection !== undefined) {
      for (const path of extractCanonicalRefPaths(phaseSection)) {
        references.push({ path, reason: "Phase canonical ref from ROADMAP.md" });
      }
      if (
        phaseSection.includes("**Requirements**:") &&
        existsSync(join(planningDir, "REQUIREMENTS.md"))
      ) {
        references.push({ path: ".planning/REQUIREMENTS.md", reason: "Phase requirements source" });
      }
    }
  }

  if (existsSync(join(planningDir, "PROJECT.md"))) {
    references.push({ path: ".planning/PROJECT.md", reason: "Project context source" });
  }

  const deduped = new Map<string, { path: string; reason: string }>();
  for (const reference of references) {
    if (!deduped.has(reference.path)) {
      deduped.set(reference.path, reference);
    }
  }
  return [...deduped.values()];
}

function readRoadmapPhaseSection(content: string, phase: string): string | undefined {
  const headerPattern = /^#{3,4}\s+Phase\s+([0-9]+(?:\.[0-9]+)?):\s+(.+)$/gmu;
  const headers = [...content.matchAll(headerPattern)];
  const index = headers.findIndex((match) => match[1] === phase);
  const header = headers[index];
  if (header === undefined) {
    return undefined;
  }
  const next = headers[index + 1];
  const start = header.index ?? 0;
  const end = next?.index ?? content.length;
  return content.slice(start, end).trim();
}

function extractCanonicalRefPaths(section: string): string[] {
  const refs = new Set<string>();
  const explicitLine = section.match(/\*\*Canonical refs\*\*:\s*([^\n]+)/u)?.[1];
  if (explicitLine !== undefined) {
    for (const match of explicitLine.matchAll(/`([^`]+)`/gmu)) {
      if (match[1] !== undefined) {
        refs.add(match[1].trim());
      }
    }
  }
  return [...refs];
}

export function readDiscussCheckpoint(phaseDir: string): DiscussCheckpoint | undefined {
  const path = join(phaseDir, checkpointFileName);
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Value.Check(DiscussCheckpointSchema, parsed)) {
    throw new Error("Invalid discuss checkpoint payload");
  }
  return parsed;
}

export function writeDiscussCheckpoint(phaseDir: string, payload: DiscussCheckpoint): void {
  mkdirSync(phaseDir, { recursive: true });
  if (!Value.Check(DiscussCheckpointSchema, payload)) {
    const first = [...Value.Errors(DiscussCheckpointSchema, payload)][0];
    throw new Error(`Invalid discuss checkpoint payload: ${first?.message ?? "unknown error"}`);
  }
  writeFileSync(
    join(phaseDir, checkpointFileName),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

export function removeDiscussCheckpoint(phaseDir: string): void {
  rmSync(join(phaseDir, checkpointFileName), { force: true });
}

export function writeDiscussArtifacts(
  phaseDir: string,
  phaseFilePrefix: string,
  draft: DiscussDraft,
): void {
  mkdirSync(phaseDir, { recursive: true });
  if (!Value.Check(DiscussDraftSchema, draft)) {
    throw new Error("Invalid discuss draft payload");
  }
  writeFileSync(
    join(phaseDir, `${phaseFilePrefix}-CONTEXT.md`),
    renderContextArtifact(draft),
    "utf8",
  );
  writeFileSync(
    join(phaseDir, `${phaseFilePrefix}-DISCUSSION-LOG.md`),
    renderDiscussionLogArtifact(draft),
    "utf8",
  );
}

function extractSection(content: string, startTag: string, endTag: string): string | undefined {
  const startIndex = content.indexOf(startTag);
  const endIndex = content.indexOf(endTag);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }
  return content.slice(startIndex + startTag.length, endIndex).trim();
}

function parseBulletLines(section: string | undefined): string[] {
  if (section === undefined) {
    return [];
  }
  return section
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0 && line !== "None");
}

function parseDecisionLines(section: string | undefined): DiscussDraft["implementationDecisions"] {
  if (section === undefined) {
    return [];
  }
  const decisions: DiscussDraft["implementationDecisions"] = [];
  let currentArea = "Implementation Decisions";
  for (const rawLine of section.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("### ") && line !== "### Claude's Discretion") {
      currentArea = line.slice(4).trim();
      continue;
    }
    const match = line.match(/^- \*\*(D-[0-9]+):\*\*\s*(.+)$/u);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      decisions.push({
        id: match[1],
        area: currentArea,
        decision: match[2].trim(),
        source: "user",
      });
    }
  }
  return decisions;
}

function parseDiscretionLines(section: string | undefined): string[] {
  if (section === undefined) {
    return [];
  }
  const marker = "### Claude's Discretion";
  const markerIndex = section.indexOf(marker);
  if (markerIndex === -1) {
    return [];
  }
  return parseBulletLines(section.slice(markerIndex + marker.length));
}

function parseReferenceLines(section: string | undefined): DiscussDraft["canonicalReferences"] {
  if (section === undefined) {
    return [];
  }
  const references: DiscussDraft["canonicalReferences"] = [];
  for (const rawLine of section.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = line.match(/^- `([^`]+)` - (.+)$/u);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      references.push({ path: match[1].trim(), reason: match[2].trim() });
    }
  }
  return references;
}

export function readCurrentDiscussArtifacts(
  phaseDir: string,
  phaseFilePrefix: string,
): DiscussDraft | undefined {
  const contextPath = join(phaseDir, `${phaseFilePrefix}-CONTEXT.md`);
  if (!existsSync(contextPath)) {
    return undefined;
  }
  const context = readFileSync(contextPath, "utf8");
  const logPath = join(phaseDir, `${phaseFilePrefix}-DISCUSSION-LOG.md`);
  const discussionLog = existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .split(/\r?\n/u)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0 && line !== "# DISCUSSION LOG")
    : [];

  const domainSection = extractSection(context, "<domain>", "</domain>");
  const decisionsSection = extractSection(context, "<decisions>", "</decisions>");
  const specificsSection = extractSection(context, "<specifics>", "</specifics>");
  const referencesSection = extractSection(context, "<canonical_refs>", "</canonical_refs>");
  const codeContextSection = extractSection(context, "<code_context>", "</code_context>");
  const deferredSection = extractSection(context, "<deferred>", "</deferred>");

  const phaseBoundary =
    domainSection
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line !== "## Phase Boundary") ?? "";

  return {
    phaseBoundary,
    implementationDecisions: parseDecisionLines(decisionsSection),
    discretionAreas: parseDiscretionLines(decisionsSection),
    canonicalReferences: parseReferenceLines(referencesSection),
    existingCodeInsights: parseBulletLines(codeContextSection),
    specificIdeas: parseBulletLines(specificsSection),
    deferredIdeas: parseBulletLines(deferredSection),
    discussionLog,
    ...(discussionLog.some((line) => line.startsWith("Next step: "))
      ? {
          chainNextStep: discussionLog
            .find((line) => line.startsWith("Next step: "))
            ?.replace("Next step: ", "")
            .trim(),
        }
      : {}),
  };
}

function renderContextArtifact(draft: DiscussDraft): string {
  const decisions =
    draft.implementationDecisions.length === 0
      ? ["None"]
      : groupDecisionsByArea(draft).flatMap(([area, areaDecisions]) => [
          `### ${area}`,
          "",
          ...areaDecisions.map((decision) => `- **${decision.id}:** ${decision.decision}`),
          "",
        ]);
  const references =
    draft.canonicalReferences.length === 0
      ? ["None"]
      : draft.canonicalReferences.map(
          (reference) => `- \`${reference.path}\` - ${reference.reason}`,
        );

  return [
    "# CONTEXT",
    "",
    "<domain>",
    "## Phase Boundary",
    "",
    draft.phaseBoundary,
    "",
    "</domain>",
    "",
    "<decisions>",
    "## Implementation Decisions",
    "",
    ...decisions,
    "### Claude's Discretion",
    "",
    ...(draft.discretionAreas.length === 0
      ? ["None"]
      : draft.discretionAreas.map((item) => `- ${item}`)),
    "",
    "</decisions>",
    "",
    "<specifics>",
    "## Specific Ideas",
    "",
    ...(draft.specificIdeas.length === 0
      ? ["None"]
      : draft.specificIdeas.map((item) => `- ${item}`)),
    "",
    "</specifics>",
    "",
    "<canonical_refs>",
    "## Canonical References",
    "",
    ...references,
    "",
    "</canonical_refs>",
    "",
    "<code_context>",
    "## Existing Code Insights",
    "",
    ...(draft.existingCodeInsights.length === 0
      ? ["None"]
      : draft.existingCodeInsights.map((item) => `- ${item}`)),
    "",
    "</code_context>",
    "",
    "<deferred>",
    "## Deferred Ideas",
    "",
    ...(draft.deferredIdeas.length === 0
      ? ["None"]
      : draft.deferredIdeas.map((item) => `- ${item}`)),
    "",
    "</deferred>",
  ].join("\n");
}

function groupDecisionsByArea(
  draft: DiscussDraft,
): Array<[string, DiscussDraft["implementationDecisions"]]> {
  const groups = new Map<string, DiscussDraft["implementationDecisions"]>();
  for (const decision of draft.implementationDecisions) {
    const existing = groups.get(decision.area);
    if (existing === undefined) {
      groups.set(decision.area, [decision]);
      continue;
    }
    existing.push(decision);
  }
  return [...groups.entries()];
}

function renderDiscussionLogArtifact(draft: DiscussDraft): string {
  return [
    "# DISCUSSION LOG",
    "",
    ...(draft.discussionLog.length === 0 ? ["No discussion log captured."] : draft.discussionLog),
    ...(draft.chainNextStep === undefined ? [] : ["", `Next step: ${draft.chainNextStep}`]),
    "",
  ].join("\n");
}

export function readDiscussConfig(cwd: string): PlanningConfig | undefined {
  return readPlanningConfig(cwd);
}
