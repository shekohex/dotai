import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadModeRegistrySync, type ModeSpec, type ModesFile } from "../../mode-utils.js";

const MODE_FLAG_PREFIX = "mode-";
const modeFlagRefreshListeners = new Set<() => void>();

export function toModeFlagName(modeName: string): string | undefined {
  const normalized = modeName
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036F]/g, "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

  return normalized ? `${MODE_FLAG_PREFIX}${normalized}` : undefined;
}

function describeModeFlag(
  modeName: string,
  spec: ModeSpec | undefined,
  deps: {
    describeModeSpec: (spec: ModeSpec | undefined) => string | undefined;
    hasText: (value: string | undefined) => value is string;
  },
): string {
  const details = deps.describeModeSpec(spec);
  return deps.hasText(details)
    ? `Start in "${modeName}" mode (${details})`
    : `Start in "${modeName}" mode`;
}

export function registerModeFlags(
  pi: ExtensionAPI,
  registeredModeFlags: Map<string, string>,
  deps: {
    orderedModeNames: (data: ModesFile) => string[];
    describeModeSpec: (spec: ModeSpec | undefined) => string | undefined;
    hasText: (value: string | undefined) => value is string;
  },
): void {
  registeredModeFlags.clear();

  const loaded = loadModeRegistrySync();
  const collisions = new Set<string>();

  for (const modeName of deps.orderedModeNames(loaded.resolvedData)) {
    const flagName = toModeFlagName(modeName);
    if (!deps.hasText(flagName)) {
      continue;
    }

    const existingModeName = registeredModeFlags.get(flagName);
    if (deps.hasText(existingModeName) && existingModeName !== modeName) {
      collisions.add(flagName);
      continue;
    }

    registeredModeFlags.set(flagName, modeName);
  }

  for (const flagName of collisions) {
    registeredModeFlags.delete(flagName);
  }

  for (const [flagName, modeName] of registeredModeFlags) {
    pi.registerFlag(flagName, {
      description: describeModeFlag(modeName, loaded.resolvedData.modes[modeName], deps),
      type: "boolean",
    });
  }
}

export function subscribeModeFlagRefresh(listener: () => void): () => void {
  modeFlagRefreshListeners.add(listener);
  return () => {
    modeFlagRefreshListeners.delete(listener);
  };
}

export function notifyModeFlagRefresh(): void {
  for (const listener of modeFlagRefreshListeners) {
    try {
      listener();
    } catch {
      modeFlagRefreshListeners.delete(listener);
    }
  }
}

export function getStartupModeSelection(
  pi: ExtensionAPI,
  modeNames: string[],
): {
  selectedMode?: string;
  requestedModes: string[];
} {
  const modeFlags = new Map<string, string>();
  const collisions = new Set<string>();

  for (const modeName of modeNames) {
    const flagName = toModeFlagName(modeName);
    if (flagName === undefined) {
      continue;
    }

    const existingModeName = modeFlags.get(flagName);
    if (existingModeName !== undefined && existingModeName !== modeName) {
      collisions.add(flagName);
      continue;
    }

    modeFlags.set(flagName, modeName);
  }

  for (const flagName of collisions) {
    modeFlags.delete(flagName);
  }

  const requestedModes: string[] = [];

  for (const [flagName, modeName] of modeFlags) {
    if (pi.getFlag(flagName) === true) {
      requestedModes.push(modeName);
    }
  }

  return { selectedMode: requestedModes[0], requestedModes };
}

export function notifyStartupModeConflict(ctx: ExtensionContext, requestedModes: string[]): void {
  if (requestedModes.length < 2) {
    return;
  }

  const message = `Multiple mode flags specified (${requestedModes.join(", ")}). Using "${requestedModes[0]}"`;
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
    return;
  }

  console.warn(message);
}
