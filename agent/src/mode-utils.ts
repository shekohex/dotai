import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ThemeColor as PackageThemeColor } from "@mariozechner/pi-coding-agent";

const themeColorNames = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
] as const satisfies readonly PackageThemeColor[];

export type ThemeColor = (typeof themeColorNames)[number];

export const ThemeColorSchema = Type.Union(themeColorNames.map((name) => Type.Literal(name)));

export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);

export const ModeSpecSchema = Type.Object({
  provider: Type.Optional(Type.String()),
  modelId: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  color: Type.Optional(ThemeColorSchema),
});

export const ModesFileSchema = Type.Object({
  version: Type.Literal(1),
  currentMode: Type.Optional(Type.String()),
  modes: Type.Record(Type.String(), ModeSpecSchema),
});

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export type ModeSpec = Static<typeof ModeSpecSchema>;
export type ModesFile = Static<typeof ModesFileSchema>;
export type ModeMap = Record<string, ModeSpec>;
export type ModesFileFor<TModes extends ModeMap> = {
  version: 1;
  currentMode?: Extract<keyof TModes, string>;
  modes: TModes;
};

export type LoadedModesFile = {
  path: string;
  source: "project" | "global" | "missing";
  data: ModesFile;
  error?: string;
};

type LoadedModesSource = {
  path: string;
  exists: boolean;
  data?: ModesFile;
  error?: string;
};

export function defineModesFile<const TModes extends ModeMap>(data: ModesFileFor<TModes>): ModesFileFor<TModes> {
  return data;
}

function assertModesFileConsistency(data: ModesFile): ModesFile {
  if (data.currentMode && !(data.currentMode in data.modes)) {
    throw new Error(`Invalid modes.json: currentMode "${data.currentMode}" is not defined in modes`);
  }

  return data;
}

function createEmptyModesFile(): ModesFile {
  return { version: 1, currentMode: undefined, modes: {} };
}

function expandUserPath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function getModesProjectPath(cwd: string): string {
  return path.join(cwd, ".pi", "modes.json");
}

export function getModesGlobalPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ? expandUserPath(process.env.PI_CODING_AGENT_DIR) : getAgentDir();
  return path.join(agentDir, "modes.json");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function fileExistsSync(filePath: string): boolean {
  try {
    fsSync.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseModesFile(value: unknown): ModesFile {
  return assertModesFileConsistency(Value.Parse(ModesFileSchema, value));
}

function formatModesFileError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

function mergeModesFiles(globalData: ModesFile | undefined, projectData: ModesFile | undefined): ModesFile {
  const mergedModes = {
    ...(globalData?.modes ?? {}),
    ...(projectData?.modes ?? {}),
  };

  const currentMode = projectData?.currentMode ?? globalData?.currentMode;

  return assertModesFileConsistency({
    version: 1,
    currentMode,
    modes: mergedModes,
  });
}

function formatSourceError(path: string, error: string): string {
  return `${path}: ${error}`;
}

function formatMergedErrors(sources: LoadedModesSource[]): string | undefined {
  const errors = sources
    .filter((source) => source.error)
    .map((source) => formatSourceError(source.path, source.error!));

  if (errors.length === 0) {
    return undefined;
  }

  return errors.join("\n");
}

async function loadModesSource(filePath: string): Promise<LoadedModesSource> {
  if (!(await fileExists(filePath))) {
    return { path: filePath, exists: false };
  }

  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    return {
      path: filePath,
      exists: true,
      data: parseModesFile(raw),
    };
  } catch (error) {
    return {
      path: filePath,
      exists: true,
      error: formatModesFileError(error),
    };
  }
}

function loadModesSourceSync(filePath: string): LoadedModesSource {
  if (!fileExistsSync(filePath)) {
    return { path: filePath, exists: false };
  }

  try {
    const raw = JSON.parse(fsSync.readFileSync(filePath, "utf8"));
    return {
      path: filePath,
      exists: true,
      data: parseModesFile(raw),
    };
  } catch (error) {
    return {
      path: filePath,
      exists: true,
      error: formatModesFileError(error),
    };
  }
}

function buildLoadedModesFile(
  projectPath: string,
  globalPath: string,
  projectSource: LoadedModesSource,
  globalSource: LoadedModesSource,
): LoadedModesFile {
  const hasProject = projectSource.exists;
  const hasGlobal = globalSource.exists;
  const source = hasProject ? "project" : hasGlobal ? "global" : "missing";
  const path = hasProject ? projectPath : hasGlobal ? globalPath : projectPath;
  const error = formatMergedErrors([projectSource, globalSource]);

  try {
    return {
      path,
      source,
      data: mergeModesFiles(globalSource.data, projectSource.data),
      error,
    };
  } catch (mergeError) {
    const mergedError = formatModesFileError(mergeError);
    return {
      path,
      source,
      data: createEmptyModesFile(),
      error: error ? `${error}\n${mergedError}` : mergedError,
    };
  }
}

export async function loadModesFile(cwd: string): Promise<LoadedModesFile> {
  const projectPath = getModesProjectPath(cwd);
  const globalPath = getModesGlobalPath();
  const [projectSource, globalSource] = await Promise.all([
    loadModesSource(projectPath),
    loadModesSource(globalPath),
  ]);

  return buildLoadedModesFile(projectPath, globalPath, projectSource, globalSource);
}

export function loadModesFileSync(cwd: string): LoadedModesFile {
  const projectPath = getModesProjectPath(cwd);
  const globalPath = getModesGlobalPath();
  const projectSource = loadModesSourceSync(projectPath);
  const globalSource = loadModesSourceSync(globalPath);

  return buildLoadedModesFile(projectPath, globalPath, projectSource, globalSource);
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await ensureParentDir(filePath);
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  await fs.writeFile(tmpPath, content, "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => { });
    throw error;
  }
}

export async function saveModesFile(filePath: string, data: ModesFile): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(assertModesFileConsistency(Value.Parse(ModesFileSchema, data)), null, 2)}\n`);
}

export async function resolveModeSpec(cwd: string, modeName: string): Promise<ModeSpec | undefined> {
  const loaded = await loadModesFile(cwd);
  return loaded.data.modes[modeName];
}
