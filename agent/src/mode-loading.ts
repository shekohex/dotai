import { Value } from "typebox/value";
import { defaultModes } from "./default-modes.js";
import type {
  ModeMap,
  ModeSpec,
  ModesFile,
  ModesFileFor,
  LoadedModesFile,
} from "./mode-definitions.js";
import { ModesFileSchema } from "./mode-definitions.js";

export type LoadedModeRegistry = LoadedModesFile;

const builtInModeSources = new Map<string, ModesFile>([["default", defaultModes]]);

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

function getBuiltInModesData(): ModesFile | undefined {
  if (builtInModeSources.size === 0) {
    return undefined;
  }
  const orderedSources = Array.from(builtInModeSources.entries()).toSorted(
    ([leftName], [rightName]) => {
      if (leftName === "default" && rightName !== "default") {
        return -1;
      }
      if (leftName !== "default" && rightName === "default") {
        return 1;
      }
      return leftName.localeCompare(rightName);
    },
  );
  const modes = Object.fromEntries(
    orderedSources.flatMap(([, source]) => Object.entries(source.modes)),
  ) satisfies ModeMap;
  return assertModesFileConsistency({
    version: 1,
    currentMode: undefined,
    modes,
  });
}

export function getModesProjectPath(cwd: string): string {
  return `${cwd}/.pi/modes.json`;
}

export function getModesGlobalPath(): string {
  return "~/.pi/agent/modes.json";
}

function buildLoadedModeRegistry(cwd: string): LoadedModeRegistry {
  const builtInData = getBuiltInModesData();
  const data = builtInData ?? createEmptyModesFile();
  return {
    path: getModesProjectPath(cwd),
    source: builtInData ? "project" : "missing",
    data,
    resolvedData: data,
    error: undefined,
  };
}

export async function loadModeRegistry(cwd: string): Promise<LoadedModeRegistry> {
  await Promise.resolve();
  return buildLoadedModeRegistry(cwd);
}

export function loadModeRegistrySync(cwd: string): LoadedModeRegistry {
  return buildLoadedModeRegistry(cwd);
}

export function loadModesFile(cwd: string): Promise<LoadedModesFile> {
  return loadModeRegistry(cwd);
}

export function loadModesFileSync(cwd: string): LoadedModesFile {
  return loadModeRegistrySync(cwd);
}

export async function saveModesFile(filePath: string, data: ModesFile): Promise<void> {
  void filePath;
  void data;
  await Promise.resolve();
}

export function registerBuiltInModes(sourceName: string, data: ModesFile): void {
  builtInModeSources.set(
    sourceName,
    assertModesFileConsistency(Value.Parse(ModesFileSchema, data)),
  );
}

export function unregisterBuiltInModes(sourceName: string): void {
  builtInModeSources.delete(sourceName);
}

export function clearBuiltInModesForTests(): void {
  builtInModeSources.clear();
}

export async function resolveModeSpec(
  cwd: string,
  modeName: string,
): Promise<ModeSpec | undefined> {
  const loaded = await loadModeRegistry(cwd);
  return loaded.resolvedData.modes[modeName];
}
