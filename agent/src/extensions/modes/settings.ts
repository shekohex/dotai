import { join } from "node:path";

import { getAgentRuntime } from "../interview/settings.js";

function getSettingsPath(): string {
  return join(getAgentRuntime(), "settings.json");
}

export function getModesSettingsPath(): string {
  return getSettingsPath();
}
