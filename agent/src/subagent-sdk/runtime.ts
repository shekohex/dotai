import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { LaunchCommandBuilder } from "./launch.js";
import type { MuxAdapter } from "./mux.js";
import { createDefaultSubagentRuntimeHooks, type SubagentRuntimeHooks } from "./runtime-hooks.js";
import { SubagentRuntimeMonitoring } from "./runtime/monitoring.js";

export class SubagentRuntime extends SubagentRuntimeMonitoring {
  constructor(
    pi: ExtensionAPI,
    adapter: MuxAdapter,
    buildLaunchCommand: LaunchCommandBuilder,
    hooks: SubagentRuntimeHooks = createDefaultSubagentRuntimeHooks(pi),
  ) {
    super(pi, adapter, buildLaunchCommand, hooks);
  }
}
