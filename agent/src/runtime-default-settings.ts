import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

import { defaultSettings } from "./default-settings.js";

type JsonValue = boolean | number | string | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

export function ensureRuntimeDefaultSettings(
  settingsPath = join(getAgentDir(), "settings.json"),
): Promise<boolean> {
  const bundledDefaultSettings = parseJsonObject(
    JSON.stringify(defaultSettings),
    "bundled default settings",
  );

  return ensureSettingsFile(settingsPath, bundledDefaultSettings).catch(() => false);
}

async function ensureSettingsFile(
  settingsPath: string,
  bundledDefaultSettings: JsonObject,
): Promise<boolean> {
  await mkdir(dirname(settingsPath), { recursive: true });
  const releaseLock = await lockfile.lock(settingsPath, {
    realpath: false,
    retries: { retries: 10, minTimeout: 20, maxTimeout: 20 },
  });

  try {
    const currentSettings = await readSettingsFile(settingsPath);
    if (currentSettings.status === "missing") {
      await writeSettingsFile(settingsPath, bundledDefaultSettings);
      return true;
    }
    if (currentSettings.status === "unreadable") return false;

    const userSettings = loadMigratedUserSettings(currentSettings.contents);
    if (userSettings === undefined) return false;

    const { mergedSettings, changed } = mergeMissingDefaults(bundledDefaultSettings, userSettings);
    if (!changed) return false;

    await writeSettingsFile(settingsPath, mergedSettings);
    return true;
  } finally {
    await releaseLock();
  }
}

async function writeSettingsFile(settingsPath: string, settings: JsonObject): Promise<void> {
  const tempPath = join(dirname(settingsPath), `.settings.${process.pid}.${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(tempPath, settingsPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function readSettingsFile(
  settingsPath: string,
): Promise<
  { status: "found"; contents: string } | { status: "missing" } | { status: "unreadable" }
> {
  try {
    return { status: "found", contents: await readFile(settingsPath, "utf8") };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { status: "missing" };
    return { status: "unreadable" };
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function mergeMissingDefaults(
  defaultSettingsObject: JsonObject,
  userSettings: JsonObject,
): { mergedSettings: JsonObject; changed: boolean } {
  let changed = false;
  const mergedSettings: JsonObject = { ...userSettings };

  for (const [key, defaultValue] of Object.entries(defaultSettingsObject)) {
    if (!(key in userSettings)) {
      mergedSettings[key] = defaultValue;
      changed = true;
      continue;
    }

    const userValue = userSettings[key];
    if (isPlainObject(defaultValue) && isPlainObject(userValue)) {
      const nestedMerge = mergeMissingDefaults(defaultValue, userValue);
      if (nestedMerge.changed) {
        mergedSettings[key] = nestedMerge.mergedSettings;
        changed = true;
      }
    }
  }

  return { mergedSettings, changed };
}

function parseJsonObject(contents: string, source: string): JsonObject {
  const parsed: unknown = JSON.parse(contents);
  if (!isPlainObject(parsed)) {
    throw new Error(`Expected JSON object in ${source}`);
  }
  return parsed;
}

function loadMigratedUserSettings(contents: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isPlainObject(parsed)) return undefined;

    const migratedSettings: unknown = SettingsManager.inMemory(parsed).getGlobalSettings();
    if (!isPlainObject(migratedSettings)) return undefined;

    return migratedSettings;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
