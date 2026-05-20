import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";
import { resolvePlanningDir } from "../shared.js";
import { saveGsdSettings } from "../settings.js";
import { detectExistingPlanning } from "../state/detect.js";
import { readStateFrontmatter } from "../state/read.js";
import { readRoadmapPhases } from "../state/roadmap.js";
import { ensurePlanningDir } from "../state/write.js";
import {
  fillTemplate,
  getGsdBundleDir,
  loadBundledTemplate,
  resolveGsdBundlePath,
} from "../resources.js";
import { writeStateFields } from "../state/runtime.js";

const defaultConfig = {
  model_profile: "balanced",
  granularity: "standard",
  commit_docs: true,
  parallelization: true,
  search_gitignored: false,
  brave_search: false,
  firecrawl: false,
  exa_search: false,
} as const;

export function resolveInstructionFileName(): "AGENTS.md" | "CLAUDE.md" {
  if (process.env.CODEX_HOME !== undefined) {
    return "AGENTS.md";
  }
  return "CLAUDE.md";
}

function ensureGitRepo(cwd: string): void {
  try {
    const result = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    if (result.trim() === "true") {
      return;
    }
  } catch {}

  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
}

function ensureInstructionFile(cwd: string): void {
  const instructionFilePath = join(cwd, resolveInstructionFileName());
  const gsdToolsPath = resolveGsdBundlePath("bin", "gsd-tools.cjs");
  execFileSync(
    process.execPath,
    [gsdToolsPath, "generate-claude-md", "--output", instructionFilePath],
    {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
}

function extractAutoSourceMaterial(rawArgs: string): string {
  return rawArgs.replaceAll(/(^|\s)--auto(?=\s|$)/gu, " ").trim();
}

function isIncompleteInitialization(cwd: string): boolean {
  const planningDir = join(cwd, ".planning");
  if (!existsSync(planningDir)) {
    return false;
  }

  const roadmapPath = join(planningDir, "ROADMAP.md");
  const statePath = join(planningDir, "STATE.md");
  const roadmapText = existsSync(roadmapPath) ? readFileSync(roadmapPath, "utf8") : "";
  const stateText = existsSync(statePath) ? readFileSync(statePath, "utf8") : "";
  const instructionFilePath = join(cwd, resolveInstructionFileName());

  if (stateText.includes("Project initialization in progress")) {
    return true;
  }

  if (readRoadmapPhases(cwd).length === 0) {
    return roadmapText.includes("No phases yet.");
  }

  return !existsSync(instructionFilePath);
}

function ensureBootstrapArtifacts(cwd: string): string {
  const planningDir = ensurePlanningDir(cwd);
  const projectName = basename(cwd) || "Project";
  const templateVars = {
    "Project Name": projectName,
    date: new Date().toISOString().slice(0, 10),
    trigger: "initialization",
  };

  const configPath = join(planningDir, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
  }

  const projectPath = join(planningDir, "PROJECT.md");
  if (!existsSync(projectPath)) {
    writeFileSync(
      projectPath,
      fillTemplate(loadBundledTemplate("project.md"), templateVars),
      "utf8",
    );
  }

  const requirementsPath = join(planningDir, "REQUIREMENTS.md");
  if (!existsSync(requirementsPath)) {
    writeFileSync(
      requirementsPath,
      fillTemplate(loadBundledTemplate("requirements.md"), {
        ...templateVars,
        "from PROJECT.md": "TBD",
      }),
      "utf8",
    );
  }

  const roadmapPath = join(planningDir, "ROADMAP.md");
  if (!existsSync(roadmapPath)) {
    writeFileSync(
      roadmapPath,
      fillTemplate(loadBundledTemplate("roadmap-empty.md"), templateVars),
      "utf8",
    );
  }

  const statePath = join(planningDir, "STATE.md");
  if (!existsSync(statePath)) {
    writeFileSync(statePath, fillTemplate(loadBundledTemplate("state.md"), templateVars), "utf8");
  }

  const stateText = readFileSync(statePath, "utf8");
  const existingState = readStateFrontmatter(cwd)?.frontmatter;
  const shouldSeedPlaceholderState =
    stateText.includes("# State Template") ||
    existingState === undefined ||
    ((existingState.current_phase === undefined || String(existingState.current_phase) === "1") &&
      (existingState.current_phase_name === undefined ||
        existingState.current_phase_name === "Phase 1") &&
      (existingState.current_plan === undefined || existingState.current_plan.length === 0) &&
      (existingState.status === undefined ||
        existingState.status.length === 0 ||
        existingState.status === "Project initialization in progress"));

  if (shouldSeedPlaceholderState) {
    writeStateFields(cwd, {
      current_phase: "1",
      current_phase_name: "Phase 1",
      current_plan: "",
      status: "Project initialization in progress",
    });
  }

  return planningDir;
}

type NewProjectInitMetadata = {
  projectName: string;
  isBrownfield: boolean;
  hasCodebaseMap: boolean;
  needsCodebaseMap: boolean;
  gitWorktreeReady: boolean;
  gitRootPath: string | undefined;
  enclosingGitRootPath: string | undefined;
  hasAccidentalNestedGitRepo: boolean;
};

function isInsideGitWorktree(cwd: string): boolean {
  try {
    const result = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return result.trim() === "true";
  } catch {
    return false;
  }
}

function resolveGitTopLevel(cwd: string): string | undefined {
  try {
    const result = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const root = result.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

function equivalentPath(first: string | undefined, second: string | undefined): boolean {
  if (first === undefined || second === undefined) {
    return first === second;
  }
  return normalizeMacTmpPath(first) === normalizeMacTmpPath(second);
}

function normalizeMacTmpPath(value: string): string {
  return value.startsWith("/private/var/") ? value.slice("/private".length) : value;
}

function resolveEnclosingGitTopLevel(cwd: string): string | undefined {
  const parentDir = join(cwd, "..");
  return resolveGitTopLevel(parentDir);
}

function repoHasCommits(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function repoHasRemotes(cwd: string): boolean {
  try {
    const result = execFileSync("git", ["remote"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return result
      .split("\n")
      .map((line) => line.trim())
      .some((line) => line.length > 0);
  } catch {
    return false;
  }
}

function detectExistingCodeHints(cwd: string): boolean {
  const manifestNames = new Set([
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "requirements.txt",
    "Gemfile",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Makefile",
  ]);
  const isCodeLikePath = (entry: string): boolean =>
    manifestNames.has(entry.split("/").at(-1) ?? "") ||
    (!entry.startsWith(".") &&
      !entry.startsWith("node_modules/") &&
      !entry.startsWith("dist/") &&
      !entry.startsWith("build/") &&
      !entry.startsWith("coverage/") &&
      !entry.endsWith(".md") &&
      !entry.endsWith(".txt") &&
      !entry.endsWith(".lock") &&
      !entry.endsWith(".log"));
  try {
    const entries = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      },
    )
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return entries.some((entry) => isCodeLikePath(entry));
  } catch {
    try {
      return readdirSync(cwd, { withFileTypes: true }).some((entry) => isCodeLikePath(entry.name));
    } catch {
      return false;
    }
  }
}

function hasCodebaseMap(cwd: string): boolean {
  const codebaseDir = join(resolvePlanningDir(cwd), "codebase");
  if (!existsSync(codebaseDir)) {
    return false;
  }
  try {
    return readdirSync(codebaseDir).some((entry) => entry.endsWith(".md"));
  } catch {
    return false;
  }
}

function listExistingCodebaseDocs(cwd: string): string[] {
  const codebaseDir = join(resolvePlanningDir(cwd), "codebase");
  const documentNames = [
    "STACK.md",
    "INTEGRATIONS.md",
    "ARCHITECTURE.md",
    "STRUCTURE.md",
    "CONVENTIONS.md",
    "TESTING.md",
    "CONCERNS.md",
  ];
  return documentNames.map((name) => join(codebaseDir, name)).filter((path) => existsSync(path));
}

function buildNewProjectInitMetadata(cwd: string): NewProjectInitMetadata {
  const projectName = basename(cwd) || "Project";
  const brownfield = detectExistingCodeHints(cwd);
  const codebaseMapPresent = hasCodebaseMap(cwd);
  const gitRootPath = resolveGitTopLevel(cwd);
  const enclosingGitRootPath = resolveEnclosingGitTopLevel(cwd);
  const hasAccidentalNestedGitRepo =
    existsSync(join(cwd, ".git")) &&
    equivalentPath(gitRootPath, cwd) &&
    enclosingGitRootPath !== undefined &&
    !equivalentPath(enclosingGitRootPath, gitRootPath) &&
    !repoHasCommits(cwd) &&
    !repoHasRemotes(cwd);
  return {
    projectName,
    isBrownfield: brownfield,
    hasCodebaseMap: codebaseMapPresent,
    needsCodebaseMap: brownfield && !codebaseMapPresent,
    gitWorktreeReady: isInsideGitWorktree(cwd),
    gitRootPath: normalizeMacTmpPath(gitRootPath ?? "") || undefined,
    enclosingGitRootPath: normalizeMacTmpPath(enclosingGitRootPath ?? "") || undefined,
    hasAccidentalNestedGitRepo,
  };
}

export async function handleGsdNewProject(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
  rawArgs: string,
): Promise<void> {
  const normalizedRawArgs = rawArgs
    .trim()
    .replace(/^new-project(?:\s+|$)/u, "")
    .trim();
  if (args.auto === true && extractAutoSourceMaterial(normalizedRawArgs).length === 0) {
    ctx.ui.notify("/gsd new-project --auto requires idea text or @file input.", "warning");
    return;
  }

  const existing = detectExistingPlanning(ctx.cwd);
  if (existing.valid && !isIncompleteInitialization(ctx.cwd)) {
    ctx.ui.notify("GSD already initialized. Run /gsd progress.", "warning");
    return;
  }

  ensureGitRepo(ctx.cwd);
  const planningDir = ensureBootstrapArtifacts(ctx.cwd);
  ensureInstructionFile(ctx.cwd);
  saveGsdSettings(ctx.cwd, { enabled: true });
  ctx.ui.notify(`GSD initialized bootstrap in ${planningDir}`, "info");
  const instructionFileName = resolveInstructionFileName();
  const instructionFilePath = join(ctx.cwd, instructionFileName);
  const gsdBundleDir = getGsdBundleDir();
  const gsdToolsPath = resolveGsdBundlePath("bin", "gsd-tools.cjs");
  const initMetadata = buildNewProjectInitMetadata(ctx.cwd);
  const existingCodebaseDocs = listExistingCodebaseDocs(ctx.cwd);

  if (initMetadata.hasAccidentalNestedGitRepo) {
    ctx.ui.notify(
      "Detected nested git repo inside parent worktree. Current directory may have accidental `.git/`.",
      "warning",
    );
  }

  let commandArguments: string | undefined;
  if (normalizedRawArgs.length > 0) {
    commandArguments = normalizedRawArgs;
  } else if (args.auto === true) {
    commandArguments = "--auto";
  } else {
    commandArguments = args.input;
  }

  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "new-project",
    commandArguments,
    sessionStrategy: "current",
    commandResourcePath: "commands/gsd/new-project.md",
    workflowResourcePaths: ["workflows/new-project.md"],
    extraResourcePaths: [
      "references/questioning.md",
      "references/ui-brand.md",
      "templates/project.md",
      "templates/requirements.md",
      "templates/roadmap.md",
      "templates/roadmap-empty.md",
      "templates/state.md",
      "templates/research-project/ARCHITECTURE.md",
      "templates/research-project/FEATURES.md",
      "templates/research-project/PITFALLS.md",
      "templates/research-project/STACK.md",
      "templates/research-project/SUMMARY.md",
      "agents/gsd-project-researcher.md",
      "agents/gsd-research-synthesizer.md",
      "agents/gsd-roadmapper.md",
    ],
    extraRequiredReadingPaths: existingCodebaseDocs,
    extraInstructions: [
      "Prepared `.planning/` files already exist. Improve them in place instead of recreating them.",
      "Preflight already completed by local handler before this steer prompt: git repo ensured and `.planning/` bootstrap files seeded. Do not run `git init` or re-bootstrap initialization yourself.",
      "Collect init preferences early, including granularity, then rewrite `.planning/config.json` with chosen settings before roadmap work.",
      "Use `interview` for structured choices when helpful. Use normal conversation for freeform exploration.",
      `Init metadata: PROJECT_NAME=${initMetadata.projectName}`,
      `Init metadata: IS_BROWNFIELD=${initMetadata.isBrownfield}`,
      `Init metadata: HAS_CODEBASE_MAP=${initMetadata.hasCodebaseMap}`,
      `Init metadata: NEEDS_CODEBASE_MAP=${initMetadata.needsCodebaseMap}`,
      `Init metadata: GIT_WORKTREE_READY=${initMetadata.gitWorktreeReady}`,
      `Init metadata: GIT_ROOT_PATH=${initMetadata.gitRootPath ?? ""}`,
      `Init metadata: ENCLOSING_GIT_ROOT_PATH=${initMetadata.enclosingGitRootPath ?? ""}`,
      `Init metadata: HAS_ACCIDENTAL_NESTED_GIT_REPO=${initMetadata.hasAccidentalNestedGitRepo}`,
      `Init metadata: CODEBASE_DOCS=${existingCodebaseDocs.join(",")}`,
      `Runtime contract: GSD_BUNDLE_DIR=${gsdBundleDir}`,
      `Runtime contract: GSD_TOOLS_PATH=${gsdToolsPath}`,
      `Runtime contract: INSTRUCTION_FILE_NAME=${instructionFileName}`,
      `Runtime contract: INSTRUCTION_FILE_PATH=${instructionFilePath}`,
      `Runtime contract: AVAILABLE_AGENT_TYPES=gsd-project-researcher,gsd-research-synthesizer,gsd-roadmapper`,
      "Runtime contract: if named delegated agents are unavailable at execution time, do equivalent work in main session and write same artifacts directly.",
      `Delegation map: researcher prompt=${resolveGsdBundlePath("agents", "gsd-project-researcher.md")}`,
      `Delegation map: synthesizer prompt=${resolveGsdBundlePath("agents", "gsd-research-synthesizer.md")}`,
      `Delegation map: roadmapper prompt=${resolveGsdBundlePath("agents", "gsd-roadmapper.md")}`,
      `Delegation map: template STACK=${resolveGsdBundlePath("templates", "research-project", "STACK.md")}`,
      `Delegation map: template FEATURES=${resolveGsdBundlePath("templates", "research-project", "FEATURES.md")}`,
      `Delegation map: template ARCHITECTURE=${resolveGsdBundlePath("templates", "research-project", "ARCHITECTURE.md")}`,
      `Delegation map: template PITFALLS=${resolveGsdBundlePath("templates", "research-project", "PITFALLS.md")}`,
      `Delegation map: template SUMMARY=${resolveGsdBundlePath("templates", "research-project", "SUMMARY.md")}`,
      `Delegation map: template ROADMAP=${resolveGsdBundlePath("templates", "roadmap.md")}`,
      `On successful initialization, regenerate ${instructionFileName} with: node ${gsdToolsPath} generate-claude-md --output ${instructionFilePath}`,
      "If HAS_CODEBASE_MAP=true, read and use existing `.planning/codebase/*.md` docs as primary brownfield context for PROJECT.md, REQUIREMENTS.md, and ROADMAP.md generation.",
    ],
  });
}
