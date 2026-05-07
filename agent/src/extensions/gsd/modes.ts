import {
  clearBuiltInModesForTests,
  defineModesFile,
  registerBuiltInModes,
  unregisterBuiltInModes,
  type ModesFile,
} from "../../mode-utils.js";
import { notifyModeFlagRefresh } from "../modes/flags.js";
import { loadBundledPrompt } from "./resources.js";
import type { GsdRole } from "./roles.js";
import { listGsdRoles, resolveRoleBuiltInModeSpec, resolveRoleModeName } from "./roles.js";

function buildRoleModeSpec(role: GsdRole) {
  return {
    ...resolveRoleBuiltInModeSpec(role),
    systemPrompt: loadBundledPrompt(role),
  };
}

export function buildBuiltInGsdModes(): ModesFile {
  const modes = Object.fromEntries(
    listGsdRoles().map((role) => [resolveRoleModeName(role), buildRoleModeSpec(role)] as const),
  );
  return defineModesFile({
    version: 1,
    modes,
  });
}

export function registerBuiltInGsdModes(): void {
  registerBuiltInModes("gsd", buildBuiltInGsdModes());
  notifyModeFlagRefresh();
}

export function unregisterBuiltInGsdModesForTests(): void {
  unregisterBuiltInModes("gsd");
  clearBuiltInModesForTests();
}
