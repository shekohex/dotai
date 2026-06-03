import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { renderWorkflowResource } from "./resource-workflows.js";

const execFile = promisify(execFileCallback);
const maxBuffer = 20 * 1024 * 1024;

export interface SimplifyChangeContext {
  diffCommand: string;
  diff: string;
  status: string;
  stat: string;
}

export function generateSimplifyWorkflow(): string {
  return renderWorkflowResource("simplify.workflow.js");
}

export async function collectSimplifyDiff(cwd: string): Promise<string> {
  const context = await collectSimplifyChangeContext(cwd);
  return context.diff;
}

export async function collectSimplifyChangeContext(cwd: string): Promise<SimplifyChangeContext> {
  const stagedFiles = await gitOutput(cwd, ["diff", "--cached", "--name-only"]);
  const diffArgs = stagedFiles.trim().length > 0 ? ["diff", "HEAD"] : ["diff"];
  const [diff, status, stat] = await Promise.all([
    gitOutput(cwd, diffArgs),
    gitOutput(cwd, ["status", "--short"]),
    gitOutput(cwd, [...diffArgs, "--stat"]),
  ]);
  return { diffCommand: `git ${diffArgs.join(" ")}`, diff, status, stat };
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, { cwd, maxBuffer });
    return stdout;
  } catch {
    return "";
  }
}
