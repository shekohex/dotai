import { Value } from "typebox/value";
import { defaultModes } from "./default-modes.js";
import type {
  LoadedModesFile,
  ModeMap,
  ModeSpec,
  ModesFile,
  ModesFileFor,
} from "./mode-definitions.js";
import { ModesFileSchema } from "./mode-definitions.js";

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
      `Invalid mode registry: currentMode "${data.currentMode}" is not defined in modes`,
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

function createLoadedModesFile(data: ModesFile): LoadedModesFile & ModesFile {
  return {
    ...data,
    path: "built-in",
    source: "global",
    data,
    resolvedData: data,
  };
}

export async function loadModeRegistry(_cwd?: string): Promise<LoadedModesFile> {
  await Promise.resolve();
  return createLoadedModesFile(getBuiltInModesData() ?? createEmptyModesFile());
}

export function loadModeRegistrySync(_cwd?: string): LoadedModesFile {
  return createLoadedModesFile(getBuiltInModesData() ?? createEmptyModesFile());
}

export function loadModesFile(cwd?: string): Promise<LoadedModesFile> {
  return loadModeRegistry(cwd);
}

export function loadModesFileSync(cwd?: string): LoadedModesFile {
  return loadModeRegistrySync(cwd);
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

export async function resolveModeSpec(modeName: string): Promise<ModeSpec | undefined> {
  const modes = await loadModeRegistry();
  return modes.resolvedData.modes[modeName];
}
