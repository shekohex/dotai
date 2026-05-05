import { join } from "node:path";

export const GSD_COMMAND = "gsd";
export const GSD_STATUS_KEY = "gsd";
export const GSD_SETTINGS_DIR = ".pi";
export const GSD_SETTINGS_FILE = "gsd.json";
export const PLANNING_DIR = ".planning";
export const PHASES_DIR = "phases";

export function resolvePlanningDir(cwd: string): string {
  return join(cwd, PLANNING_DIR);
}

export function resolvePhasesDir(cwd: string): string {
  return join(resolvePlanningDir(cwd), PHASES_DIR);
}

export function resolveGsdSettingsPath(cwd: string): string {
  return join(cwd, GSD_SETTINGS_DIR, GSD_SETTINGS_FILE);
}
