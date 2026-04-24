import fsSync, { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import pathLib from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Value } from "typebox/value";
import type {
  ModeMap,
  ModeSpec,
  ModesFile,
  ModesFileFor,
  LoadedModesFile,
} from "./mode-definitions.js";
import { ModesFileSchema } from "./mode-definitions.js";

type LoadedModesSource = {
  path: string;
  exists: boolean;
  data?: ModesFile;
  resolvedData?: ModesFile;
  error?: string;
};

const systemPromptFileReferencePattern = /^\{file:(.+)\}$/s;

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export function defineModesFile<const TModes extends ModeMap>(
  data: ModesFileFor<TModes>,
): ModesFileFor<TModes> {
  return data;
}

function assertModesFileConsistency(data: ModesFile): ModesFile {
  if (hasText(data.currentMode) && !(data.currentMode in data.modes)) {
    throw new Error(
      `Invalid modes.json: currentMode "${data.currentMode}" is not defined in modes`,
    );
  }
  return data;
}

function createEmptyModesFile(): ModesFile {
  return { version: 1, currentMode: undefined, modes: {} };
}

function expandUserPath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return pathLib.join(os.homedir(), value.slice(2));
  return value;
}

export function getModesProjectPath(cwd: string): string {
  return pathLib.join(cwd, ".pi", "modes.json");
}

export function getModesGlobalPath(): string {
  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = hasText(configuredAgentDir) ? expandUserPath(configuredAgentDir) : getAgentDir();
  return pathLib.join(agentDir, "modes.json");
}

function parseModesFile(value: unknown): ModesFile {
  return assertModesFileConsistency(Value.Parse(ModesFileSchema, value));
}

function getReferencedSystemPromptPath(
  systemPrompt: string,
  modesFilePath: string,
): string | undefined {
  const match = systemPrompt.match(systemPromptFileReferencePattern);
  if (!match) {
    return undefined;
  }
  const referencedPath = match[1]?.trim();
  if (!referencedPath) {
    throw new Error("Invalid modes.json: systemPrompt file reference cannot be empty");
  }
  return pathLib.resolve(pathLib.dirname(modesFilePath), referencedPath);
}

function normalizeModeSpec(spec: ModeSpec, resolvedSystemPrompt = spec.systemPrompt): ModeSpec {
  const missingResolvedPrompt = resolvedSystemPrompt === undefined;
  return {
    ...spec,
    ...(missingResolvedPrompt ? {} : { systemPrompt: resolvedSystemPrompt }),
    ...(missingResolvedPrompt || spec.systemPromptMode !== undefined
      ? {}
      : { systemPromptMode: "append" as const }),
  };
}

async function resolveModeSpecAssets(spec: ModeSpec, modesFilePath: string): Promise<ModeSpec> {
  const referencedSystemPromptPath =
    spec.systemPrompt === undefined
      ? undefined
      : getReferencedSystemPromptPath(spec.systemPrompt, modesFilePath);
  if (referencedSystemPromptPath === undefined) {
    return normalizeModeSpec(spec);
  }
  const systemPrompt = await fs.readFile(referencedSystemPromptPath, "utf8");
  return normalizeModeSpec(spec, systemPrompt);
}

function resolveModeSpecAssetsSync(spec: ModeSpec, modesFilePath: string): ModeSpec {
  const referencedSystemPromptPath =
    spec.systemPrompt === undefined
      ? undefined
      : getReferencedSystemPromptPath(spec.systemPrompt, modesFilePath);
  if (referencedSystemPromptPath === undefined) {
    return normalizeModeSpec(spec);
  }
  const systemPrompt = fsSync.readFileSync(referencedSystemPromptPath, "utf8");
  return normalizeModeSpec(spec, systemPrompt);
}

async function resolveModesFileAssets(data: ModesFile, modesFilePath: string): Promise<ModesFile> {
  const modes = Object.fromEntries(
    await Promise.all(
      Object.entries(data.modes).map(
        async ([modeName, spec]) =>
          [modeName, await resolveModeSpecAssets(spec, modesFilePath)] as const,
      ),
    ),
  );
  return assertModesFileConsistency({ ...data, modes });
}

function resolveModesFileAssetsSync(data: ModesFile, modesFilePath: string): ModesFile {
  const modes = Object.fromEntries(
    Object.entries(data.modes).map(
      ([modeName, spec]) => [modeName, resolveModeSpecAssetsSync(spec, modesFilePath)] as const,
    ),
  );
  return assertModesFileConsistency({ ...data, modes });
}

function formatModesFileError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function tryMergeModesFiles(
  globalData: ModesFile | undefined,
  projectData: ModesFile | undefined,
): { data?: ModesFile; error?: string } {
  try {
    return {
      data: assertModesFileConsistency({
        version: 1,
        currentMode: projectData?.currentMode ?? globalData?.currentMode,
        modes: { ...globalData?.modes, ...projectData?.modes },
      }),
    };
  } catch (error) {
    return { error: formatModesFileError(error) };
  }
}

function formatMergedErrors(sources: LoadedModesSource[]): string | undefined {
  const errors = sources
    .filter((source): source is LoadedModesSource & { error: string } => hasText(source.error))
    .map((source) => `${source.path}: ${source.error}`);
  return errors.length > 0 ? errors.join("\n") : undefined;
}

async function loadModesSource(filePath: string): Promise<LoadedModesSource> {
  if (!existsSync(filePath)) {
    return { path: filePath, exists: false };
  }
  try {
    const raw: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    const data = parseModesFile(raw);
    return {
      path: filePath,
      exists: true,
      data,
      resolvedData: await resolveModesFileAssets(data, filePath),
    };
  } catch (error) {
    return { path: filePath, exists: true, error: formatModesFileError(error) };
  }
}

function loadModesSourceSync(filePath: string): LoadedModesSource {
  if (!existsSync(filePath)) {
    return { path: filePath, exists: false };
  }
  try {
    const raw: unknown = JSON.parse(fsSync.readFileSync(filePath, "utf8"));
    const data = parseModesFile(raw);
    return {
      path: filePath,
      exists: true,
      data,
      resolvedData: resolveModesFileAssetsSync(data, filePath),
    };
  } catch (error) {
    return { path: filePath, exists: true, error: formatModesFileError(error) };
  }
}

function buildLoadedModesFile(
  projectPath: string,
  globalPath: string,
  projectSource: LoadedModesSource,
  globalSource: LoadedModesSource,
): LoadedModesFile {
  let source: "project" | "global" | "missing" = "missing";
  if (projectSource.exists) {
    source = "project";
  } else if (globalSource.exists) {
    source = "global";
  }
  const resolvedPath = projectSource.exists || !globalSource.exists ? projectPath : globalPath;
  const sourceError = formatMergedErrors([projectSource, globalSource]);
  const merged = tryMergeModesFiles(globalSource.data, projectSource.data);
  const resolved = tryMergeModesFiles(globalSource.resolvedData, projectSource.resolvedData);
  const errors = Array.from(
    new Set(
      [sourceError, merged.error, resolved.error].filter((value): value is string =>
        hasText(value),
      ),
    ),
  );
  return {
    path: resolvedPath,
    source,
    data: merged.data ?? createEmptyModesFile(),
    resolvedData: resolved.data ?? createEmptyModesFile(),
    error: errors.length > 0 ? errors.join("\n") : undefined,
  };
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
  return buildLoadedModesFile(
    projectPath,
    globalPath,
    loadModesSourceSync(projectPath),
    loadModesSourceSync(globalPath),
  );
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(pathLib.dirname(filePath), { recursive: true });
  const tmpPath = pathLib.join(
    pathLib.dirname(filePath),
    `.${pathLib.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.writeFile(tmpPath, content, "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export async function saveModesFile(filePath: string, data: ModesFile): Promise<void> {
  await atomicWrite(
    filePath,
    `${JSON.stringify(assertModesFileConsistency(Value.Parse(ModesFileSchema, data)), null, 2)}\n`,
  );
}

export async function resolveModeSpec(
  cwd: string,
  modeName: string,
): Promise<ModeSpec | undefined> {
  const loaded = await loadModesFile(cwd);
  return loaded.resolvedData.modes[modeName];
}
