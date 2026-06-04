import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDefaultSubagentRuntimeHooks } from "../../../subagent-sdk/index.js";
import type { SubagentRuntimeHooks } from "../../../subagent-sdk/runtime-hooks.js";

export function createGsdSubagentRuntimeHooks(pi: ExtensionAPI): SubagentRuntimeHooks {
  return createDefaultSubagentRuntimeHooks(pi, { title: "GSD Subagents" });
}
