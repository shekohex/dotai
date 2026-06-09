import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import { asRecord, readString } from "../../../utils/unknown-data.js";
import { resolvePhasesDir, resolvePlanningDir } from "../shared.js";
import { parseMarkdownFrontmatter, readLooseKeyValueSection } from "./markdown.js";
import {
  PlanFrontmatterSchema,
  PlanningConfigSchema,
  StateFrontmatterSchema,
  type PlanFrontmatter,
  type PlanningConfig,
  type StateFrontmatter,
} from "./schema.js";

export type PlanFile = {
  path: string;
  fileName: string;
  frontmatter: PlanFrontmatter;
  body: string;
  tasks: string[];
  completed: boolean;
};

export type PlanningSnapshot = {
  config?: PlanningConfig;
  state?: StateFrontmatter;
  stateBody?: string;
  readIssues: PlanningReadIssue[];
  roadmap?: string;
  project?: string;
  requirements?: string;
  goals: string[];
  milestones: string[];
  pendingTodos: string[];
  phases: PhaseSnapshot[];
};

export type PlanningReadIssue = {
  path: string;
  message: string;
};

export type PhaseSnapshot = {
  id: string;
  path: string;
  name: string;
  plans: PlanFile[];
  summaries: string[];
  verifications: string[];
  validations: string[];
  uats: string[];
  context?: string;
  research?: string;
};

export function readPlanningConfig(cwd: string): PlanningConfig | undefined {
  const configPath = join(resolvePlanningDir(cwd), "config.json");
  if (!existsSync(configPath)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!Value.Check(PlanningConfigSchema, parsed)) {
    return undefined;
  }
  return parsed;
}

export function readStateFrontmatter(
  cwd: string,
): { frontmatter: StateFrontmatter; body: string; issue?: PlanningReadIssue } | undefined {
  const statePath = join(resolvePlanningDir(cwd), "STATE.md");
  if (!existsSync(statePath)) {
    return undefined;
  }
  const content = readFileSync(statePath, "utf8");
  if (content.startsWith("---\n")) {
    try {
      return parseMarkdownFrontmatter(content, StateFrontmatterSchema);
    } catch (error) {
      return { frontmatter: {}, body: content, issue: createFrontmatterIssue(statePath, error) };
    }
  }
  const loose = readLooseKeyValueSection(content);
  const candidate: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(loose)) {
    candidate[key] = value;
  }
  if (!Value.Check(StateFrontmatterSchema, candidate)) {
    return { frontmatter: {}, body: content };
  }
  return { frontmatter: candidate, body: content };
}

export function readPlanningSnapshot(cwd: string): PlanningSnapshot {
  const planningDir = resolvePlanningDir(cwd);
  const phasesDir = resolvePhasesDir(cwd);
  const goalsDir = join(planningDir, "goals");
  const milestonesDir = join(planningDir, "milestones");
  const pendingTodosDir = join(planningDir, "todos", "pending");
  const state = readStateFrontmatter(cwd);
  const readIssues = state?.issue === undefined ? [] : [state.issue];
  const roadmapPath = join(planningDir, "ROADMAP.md");
  const projectPath = join(planningDir, "PROJECT.md");
  const requirementsPath = join(planningDir, "REQUIREMENTS.md");

  return {
    config: readPlanningConfig(cwd),
    state: state?.frontmatter,
    stateBody: state?.body,
    readIssues,
    roadmap: existsSync(roadmapPath) ? readFileSync(roadmapPath, "utf8") : undefined,
    project: existsSync(projectPath) ? readFileSync(projectPath, "utf8") : undefined,
    requirements: existsSync(requirementsPath) ? readFileSync(requirementsPath, "utf8") : undefined,
    goals: existsSync(goalsDir)
      ? readdirSync(goalsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() || entry.isFile())
          .map((entry) => entry.name)
          .toSorted((left, right) => left.localeCompare(right))
      : [],
    milestones: existsSync(milestonesDir)
      ? readdirSync(milestonesDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() || entry.isFile())
          .map((entry) => entry.name)
          .toSorted((left, right) => left.localeCompare(right))
      : [],
    pendingTodos: existsSync(pendingTodosDir)
      ? readdirSync(pendingTodosDir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .toSorted((left, right) => left.localeCompare(right))
      : [],
    phases: existsSync(phasesDir)
      ? readdirSync(phasesDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => readPhaseSnapshot(join(phasesDir, entry.name), entry.name, readIssues))
      : [],
  };
}

function readPhaseSnapshot(
  phasePath: string,
  phaseId: string,
  readIssues: PlanningReadIssue[],
): PhaseSnapshot {
  const entries = existsSync(phasePath) ? readdirSync(phasePath) : [];
  const plans: PlanFile[] = [];
  const summaries: string[] = [];
  const verifications: string[] = [];
  const validations: string[] = [];
  const uats: string[] = [];
  let context: string | undefined;
  let research: string | undefined;

  for (const fileName of entries) {
    const filePath = join(phasePath, fileName);
    if (fileName.endsWith("-PLAN.md")) {
      const content = readFileSync(filePath, "utf8");
      let parsed: ReturnType<typeof parseMarkdownFrontmatter<typeof PlanFrontmatterSchema>>;
      try {
        parsed = parseMarkdownFrontmatter(content, PlanFrontmatterSchema);
      } catch (error) {
        readIssues.push(createFrontmatterIssue(filePath, error));
        continue;
      }
      plans.push({
        path: filePath,
        fileName,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        tasks: extractPlanTasks(parsed.body),
        completed:
          fileName.replace("-PLAN.md", "-SUMMARY.md") in
          Object.fromEntries(entries.map((entry) => [entry, true])),
      });
      continue;
    }
    if (fileName.endsWith("-SUMMARY.md")) {
      summaries.push(fileName);
      continue;
    }
    if (fileName.endsWith("-VERIFICATION.md")) {
      verifications.push(fileName);
      continue;
    }
    if (fileName.endsWith("-VALIDATION.md")) {
      validations.push(fileName);
      continue;
    }
    if (fileName.endsWith("-UAT.md")) {
      uats.push(fileName);
      continue;
    }
    if (fileName.endsWith("-CONTEXT.md")) {
      context = readFileSync(filePath, "utf8");
      continue;
    }
    if (fileName.endsWith("-RESEARCH.md")) {
      research = readFileSync(filePath, "utf8");
    }
  }

  return {
    id: phaseId,
    path: phasePath,
    name: phaseId.replace(/^\d+(?:\.\d+)?-/, ""),
    plans: plans.toSorted((left, right) => left.fileName.localeCompare(right.fileName)),
    summaries,
    verifications,
    validations,
    uats,
    context,
    research,
  };
}

function createFrontmatterIssue(path: string, error: unknown): PlanningReadIssue {
  const detail = error instanceof Error ? error.message : "unknown error";
  return {
    path,
    message: `invalid frontmatter (${detail}); fix YAML value types or remove invalid field`,
  };
}

function extractPlanTasks(body: string): string[] {
  return [...body.matchAll(/^###\s+Task\s+\d+:\s+(.+)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((task): task is string => task !== undefined && task.length > 0);
}

export function extractProjectName(snapshot: PlanningSnapshot): string | undefined {
  const project = snapshot.project;
  if (project !== undefined && project.length > 0) {
    const heading = project.match(/^#\s+(.+)$/m);
    if (heading) {
      return heading[1].trim();
    }
  }
  const body = snapshot.stateBody;
  if (body === undefined || body.length === 0) {
    return undefined;
  }
  const projectLine = body.match(/\*\*Project:\*\*\s*(.+)/i);
  return projectLine?.[1]?.trim();
}

export function readConfigProjectName(cwd: string): string | undefined {
  const config = readPlanningConfig(cwd);
  const record = asRecord(config);
  return readString(record?.project_name);
}
