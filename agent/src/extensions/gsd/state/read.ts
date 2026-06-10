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

export type ParsedPlanMarkdown = ReturnType<
  typeof parseMarkdownFrontmatter<typeof PlanFrontmatterSchema>
>;

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
    const normalized = normalizeLegacyPlanningConfig(parsed);
    if (normalized === undefined || !Value.Check(PlanningConfigSchema, normalized)) {
      return undefined;
    }
    return normalized;
  }
  return parsed;
}

function normalizeLegacyPlanningConfig(value: unknown): PlanningConfig | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const modelProfile = readString(record.model_profile) ?? readString(record.mode) ?? "balanced";
  const commitDocs = typeof record.commit_docs === "boolean" ? record.commit_docs : true;
  const parallelization =
    typeof record.parallelization === "boolean" ? record.parallelization : true;
  return {
    ...record,
    model_profile: normalizeModelProfile(modelProfile),
    commit_docs: commitDocs,
    parallelization,
    search_gitignored:
      typeof record.search_gitignored === "boolean" ? record.search_gitignored : false,
    brave_search: typeof record.brave_search === "boolean" ? record.brave_search : false,
    firecrawl: typeof record.firecrawl === "boolean" ? record.firecrawl : false,
    exa_search: typeof record.exa_search === "boolean" ? record.exa_search : false,
  };
}

function normalizeModelProfile(value: string): PlanningConfig["model_profile"] {
  if (value === "quality" || value === "balanced" || value === "budget" || value === "inherit") {
    return value;
  }
  return "balanced";
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
      let parsed: ParsedPlanMarkdown;
      try {
        parsed = parsePlanMarkdownContent(fileName, content);
      } catch (error) {
        const fallback = createFallbackPlanFileParse(fileName, content);
        if (fallback === undefined) {
          readIssues.push(createFrontmatterIssue(filePath, error));
          continue;
        }
        if (!isLegacyRichPlanFrontmatter(content)) {
          readIssues.push(createFrontmatterIssue(filePath, error));
        }
        parsed = fallback;
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

export function parsePlanMarkdownContent(fileName: string, content: string): ParsedPlanMarkdown {
  try {
    return parseMarkdownFrontmatter(content, PlanFrontmatterSchema);
  } catch (error) {
    const fallback = createFallbackPlanFileParse(fileName, content);
    if (fallback !== undefined && isLegacyRichPlanFrontmatter(content)) {
      return fallback;
    }
    throw error;
  }
}

function createFallbackPlanFrontmatter(fileName: string): PlanFrontmatter {
  const match = fileName.match(/^(\d+(?:\.\d+)?)-(\d+)-PLAN\.md$/u);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("invalid PLAN filename");
  }
  return {
    phase: match[1],
    plan: match[2],
    type: "unknown",
    wave: "1",
    depends_on: [],
    files_modified: [],
    autonomous: true,
    must_haves: [],
  };
}

function createFallbackPlanFrontmatterFromContent(
  fileName: string,
  content: string,
): PlanFrontmatter {
  const fallback = createFallbackPlanFrontmatter(fileName);
  const frontmatter = extractRawFrontmatter(content);
  if (frontmatter === undefined) {
    return fallback;
  }

  return {
    ...fallback,
    phase: readRawScalar(frontmatter, "phase") ?? fallback.phase,
    plan: readRawScalar(frontmatter, "plan") ?? fallback.plan,
    type: readRawScalar(frontmatter, "type") ?? fallback.type,
    wave: readRawScalar(frontmatter, "wave") ?? fallback.wave,
    depends_on: readRawList(frontmatter, "depends_on") ?? fallback.depends_on,
    files_modified: readRawList(frontmatter, "files_modified") ?? fallback.files_modified,
    autonomous: readRawBoolean(frontmatter, "autonomous") ?? fallback.autonomous,
    requirements: readRawList(frontmatter, "requirements"),
    must_haves: readRawMustHaves(frontmatter) ?? fallback.must_haves,
  };
}

function createFallbackPlanFileParse(
  fileName: string,
  content: string,
): ReturnType<typeof parseMarkdownFrontmatter<typeof PlanFrontmatterSchema>> | undefined {
  if (!/^(\d+(?:\.\d+)?)-(\d+)-PLAN\.md$/u.test(fileName)) {
    return undefined;
  }
  const closingIndex = content.startsWith("---\n") ? content.indexOf("\n---\n", 4) : -1;
  const body = closingIndex === -1 ? content : content.slice(closingIndex + 5);
  return { frontmatter: createFallbackPlanFrontmatterFromContent(fileName, content), body };
}

function isLegacyRichPlanFrontmatter(content: string): boolean {
  return /^must_haves:\s*$/mu.test(content) && /^\s+(artifacts|key_links):\s*$/mu.test(content);
}

function extractRawFrontmatter(content: string): string | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/u);
  return match?.[1];
}

function readRawScalar(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "mu"));
  return stripYamlQuotes(match?.[1]?.trim());
}

function readRawBoolean(frontmatter: string, key: string): boolean | string | undefined {
  const value = readRawScalar(frontmatter, key);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value;
}

function readRawList(frontmatter: string, key: string): string[] | undefined {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) {
    const inline = readRawScalar(frontmatter, key);
    if (inline === undefined) {
      return undefined;
    }
    if (inline === "[]") {
      return [];
    }
    return [inline];
  }
  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) {
      break;
    }
    const item = line.match(/^\s*-\s+(.+)$/u)?.[1];
    if (item !== undefined) {
      values.push(stripYamlQuotes(item) ?? item);
    }
  }
  return values;
}

function readRawMustHaves(frontmatter: string): PlanFrontmatter["must_haves"] | undefined {
  if (!/^must_haves:\s*$/mu.test(frontmatter)) {
    return readRawList(frontmatter, "must_haves") ?? readRawScalar(frontmatter, "must_haves");
  }
  return {
    truths: readRawNestedStringList(frontmatter, "truths"),
    artifacts: readRawNestedObjectList(frontmatter, "artifacts"),
    key_links: readRawNestedObjectList(frontmatter, "key_links"),
  };
}

function readRawNestedStringList(frontmatter: string, key: string): string[] | undefined {
  return readRawNestedSectionItems(frontmatter, key)
    ?.map((item) => item.firstValue)
    .filter((item) => item.length > 0);
}

function readRawNestedObjectList(
  frontmatter: string,
  key: string,
): Array<Record<string, string>> | undefined {
  return readRawNestedSectionItems(frontmatter, key)?.map((item) => item.fields);
}

function readRawNestedSectionItems(
  frontmatter: string,
  key: string,
): Array<{ firstValue: string; fields: Record<string, string> }> | undefined {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start === -1) {
    return undefined;
  }
  const items: Array<{ firstValue: string; fields: Record<string, string> }> = [];
  let current: { firstValue: string; fields: Record<string, string> } | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^\s{2}\S/u.test(line)) {
      break;
    }
    const item = line.match(/^\s{4}-\s+(.+)$/u)?.[1];
    if (item !== undefined) {
      current = { firstValue: stripYamlQuotes(item) ?? item, fields: {} };
      const field = item.match(/^([^:]+):\s*(.+)$/u);
      if (field?.[1] !== undefined && field[2] !== undefined) {
        current.fields[field[1].trim()] = stripYamlQuotes(field[2].trim()) ?? field[2].trim();
      }
      items.push(current);
      continue;
    }
    const field = line.match(/^\s{6}([^:]+):\s*(.+)$/u);
    if (current !== undefined && field?.[1] !== undefined && field[2] !== undefined) {
      current.fields[field[1].trim()] = stripYamlQuotes(field[2].trim()) ?? field[2].trim();
    }
  }
  return items;
}

function stripYamlQuotes(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.replace(/^(["'])(.*)\1$/u, "$2");
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
