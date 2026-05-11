import { extname, isAbsolute, relative, resolve } from "node:path";

export type Phase = "idle" | "planning" | "executing";

export const PLAN_SUBMIT_TOOL = "submit_plan";

const PLANNING_ONLY_TOOLS = new Set<string>([PLAN_SUBMIT_TOOL]);
const ALLOWED_PLAN_EXTENSIONS = new Set<string>([".md", ".mdx"]);

export function stripPlanningOnlyTools(tools: readonly string[]): string[] {
  return tools.filter((tool) => !PLANNING_ONLY_TOOLS.has(tool));
}

export function getToolsForPhase(baseTools: readonly string[], phase: Phase): string[] {
  const tools = stripPlanningOnlyTools(baseTools);
  if (phase !== "planning") {
    return [...new Set(tools)];
  }

  return [...new Set([...tools, PLAN_SUBMIT_TOOL])];
}

// Used by both planning-phase write gate and submit_plan.
// Path must resolve inside cwd (no traversal, no absolute escape) and end
// in a permitted markdown extension.
export function isPlanWritePathAllowed(inputPath: string, cwd: string): boolean {
  if (!inputPath) return false;
  const targetAbs = resolve(cwd, inputPath);
  const rel = relative(resolve(cwd), targetAbs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const ext = extname(targetAbs).toLowerCase();
  return ALLOWED_PLAN_EXTENSIONS.has(ext);
}

export function getApplyPatchPaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const line of patchText.split(/\r?\n/u)) {
    if (line.startsWith("*** Add File: ")) {
      paths.push(line.slice("*** Add File: ".length).trim());
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      paths.push(line.slice("*** Update File: ".length).trim());
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      paths.push(line.slice("*** Delete File: ".length).trim());
    }
  }
  return paths;
}
