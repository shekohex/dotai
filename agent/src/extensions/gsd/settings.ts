import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveGsdSettingsPath } from "./shared.js";
import { parseGsdSettings, type GsdSettings } from "./state/schema.js";

const settingsCache = new Map<string, GsdSettings>();

export function getGsdSettings(cwd: string): GsdSettings {
  const cached = settingsCache.get(cwd);
  if (cached) {
    return cached;
  }
  const path = resolveGsdSettingsPath(cwd);
  const parsed = existsSync(path)
    ? parseGsdSettings(JSON.parse(readFileSync(path, "utf8")) as unknown)
    : { enabled: false };
  settingsCache.set(cwd, parsed);
  return parsed;
}

export function saveGsdSettings(cwd: string, settings: GsdSettings): void {
  const path = resolveGsdSettingsPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  settingsCache.set(cwd, settings);
}
