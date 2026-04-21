import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadModesFileSync, type ModeSpec, type ModesFile } from "../../mode-utils.js";

const MODE_FLAG_PREFIX = "mode-";

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

  const loaded = loadModesFileSync(process.cwd());
  const collisions = new Set<string>();

  for (const modeName of deps.orderedModeNames(loaded.data)) {
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
      description: describeModeFlag(modeName, loaded.data.modes[modeName], deps),
      type: "boolean",
    });
  }
}

export function getStartupModeSelection(
  pi: ExtensionAPI,
  registeredModeFlags: Map<string, string>,
): {
  selectedMode?: string;
  requestedModes: string[];
} {
  const requestedModes: string[] = [];

  for (const [flagName, modeName] of registeredModeFlags) {
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
