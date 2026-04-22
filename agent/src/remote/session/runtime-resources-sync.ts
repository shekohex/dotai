import { readFileSync } from "node:fs";
import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import { defaultSettings } from "../../default-settings.js";
import type { SessionRecord } from "./types.js";

type RuntimeSession = NonNullable<AgentSessionRuntime["session"]>;

export function applyRuntimeResourcesSnapshot(
  record: SessionRecord,
  session: RuntimeSession,
): void {
  const resourceLoader = readRuntimeResourceLoader(session);
  if (!resourceLoader) {
    record.settings = readRuntimeSettingsSnapshot(session);
    return;
  }

  const skills = resourceLoader.getSkills().skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    disableModelInvocation: skill.disableModelInvocation,
    content: readResourceText(skill.filePath),
  }));
  const prompts = resourceLoader.getPrompts().prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    filePath: prompt.filePath,
    content: prompt.content,
  }));
  const themes = resourceLoader.getThemes().themes.flatMap((theme) => {
    const sourcePath = theme.sourcePath;
    if (sourcePath === undefined || sourcePath.length === 0) {
      return [];
    }
    return [
      {
        name: theme.name ?? sourcePath,
        sourcePath,
        content: readResourceText(sourcePath),
      },
    ];
  });

  record.resources = {
    skills,
    prompts,
    themes,
    systemPrompt: resourceLoader.getSystemPrompt() ?? null,
    appendSystemPrompt: [...resourceLoader.getAppendSystemPrompt()],
  };
  record.settings = readRuntimeSettingsSnapshot(session);
}

export function readRuntimeSettingsSnapshot(session: RuntimeSession): SessionRecord["settings"] {
  if (!isSettingsSnapshotReader(session.settingsManager)) {
    return {
      ...defaultSettings,
    };
  }

  const globalSettings = session.settingsManager.getGlobalSettings();
  const projectSettings = session.settingsManager.getProjectSettings();
  const hasPersistedSettings =
    Object.keys(globalSettings).length > 0 || Object.keys(projectSettings).length > 0;

  if (!hasPersistedSettings) {
    return {
      ...defaultSettings,
    };
  }

  return {
    ...defaultSettings,
    ...globalSettings,
    ...projectSettings,
  };
}

type SettingsSnapshotReader = {
  getGlobalSettings: () => Record<string, unknown>;
  getProjectSettings: () => Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSettingsSnapshotReader(value: unknown): value is SettingsSnapshotReader {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.getGlobalSettings === "function" && typeof value.getProjectSettings === "function"
  );
}

function readRuntimeResourceLoader(
  session: RuntimeSession,
): RuntimeSession["resourceLoader"] | undefined {
  const candidate = session.resourceLoader;
  if (!isRuntimeResourceLoader(candidate)) {
    return undefined;
  }
  return candidate;
}

function isRuntimeResourceLoader(value: unknown): value is RuntimeSession["resourceLoader"] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.getSkills === "function" &&
    typeof value.getPrompts === "function" &&
    typeof value.getThemes === "function" &&
    typeof value.getSystemPrompt === "function" &&
    typeof value.getAppendSystemPrompt === "function"
  );
}

function readResourceText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
