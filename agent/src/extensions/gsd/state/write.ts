import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePlanningDir } from "../shared.js";

export function writeTextFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, content, "utf8");
  writeFileSync(path, content, "utf8");
}

export function ensurePlanningDir(cwd: string): string {
  const planningDir = resolvePlanningDir(cwd);
  mkdirSync(planningDir, { recursive: true });
  mkdirSync(join(planningDir, "phases"), { recursive: true });
  mkdirSync(join(planningDir, "milestones"), { recursive: true });
  mkdirSync(join(planningDir, "research"), { recursive: true });
  return planningDir;
}
