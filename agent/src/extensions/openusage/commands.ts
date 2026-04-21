import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { createOpenUsageCommandHandler } from "./command-handlers.js";
import type { OpenUsageRuntimeState, SupportedProviderId } from "./types.js";

const ROOT_COMPLETIONS = [
  "status",
  "status codex",
  "status zai",
  "refresh",
  "refresh codex",
  "refresh zai",
  "debug",
  "debug codex",
  "debug zai",
  "account",
  "account codex",
  "account zai",
  "account clear",
  "account clear codex",
  "account clear zai",
  "setting",
  "setting reset-time",
  "setting reset-time relative",
  "setting reset-time absolute",
  "settings",
  "settings reset-time",
  "settings reset-time relative",
  "settings reset-time absolute",
];

export function registerOpenUsageCommands(
  pi: ExtensionAPI,
  state: OpenUsageRuntimeState,
  refreshProvider: (
    providerId: SupportedProviderId,
    ctx: ExtensionCommandContext,
    options?: { force?: boolean },
  ) => Promise<void>,
): void {
  registerCommand(pi, "openusage", state, refreshProvider);
  registerCommand(pi, "usage", state, refreshProvider);
}

function registerCommand(
  pi: ExtensionAPI,
  name: string,
  state: OpenUsageRuntimeState,
  refreshProvider: (
    providerId: SupportedProviderId,
    ctx: ExtensionCommandContext,
    options?: { force?: boolean },
  ) => Promise<void>,
): void {
  const handler = createOpenUsageCommandHandler(pi, state, refreshProvider);
  pi.registerCommand(name, {
    description: "Show/refresh usage, switch accounts, and manage display settings",
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trim().toLowerCase();
      const items = ROOT_COMPLETIONS.filter((value) => value.startsWith(prefix)).map((value) => ({
        value,
        label: value,
      }));
      return items.length > 0 ? items : null;
    },
    handler,
  });
}
