import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getHandoffArgumentCompletions } from "./autocomplete.js";
import {
  handleHandoffAgentEnd,
  handleHandoffContext,
  handleHandoffSessionStart,
} from "./events.js";
import { handleHandoffCommand, launchHandoffSession } from "./launch.js";
import type { HandoffLaunchResult, HandoffOptions, HandoffRuntimeState } from "./shared.js";

export type { HandoffLaunchResult, HandoffOptions, HandoffRuntimeState };
export { launchHandoffSession };

export default function handoffExtension(pi: ExtensionAPI) {
  const state: HandoffRuntimeState = {};

  pi.registerCommand("handoff", {
    description:
      "Transfer context to a new focused session (-mode <name>, -model <provider/modelId>)",
    getArgumentCompletions: (prefix) => getHandoffArgumentCompletions(prefix, state),
    handler: (args, ctx) => handleHandoffCommand(pi, state, args, ctx),
  });

  pi.on("agent_end", (_event, ctx) => {
    void handleHandoffAgentEnd(pi, ctx);
  });
  pi.on("context", (event) => handleHandoffContext(event));
  pi.on("session_start", (event, ctx) => {
    void handleHandoffSessionStart(pi, state, event, ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    state.ctx = ctx;
  });

  pi.on("before_agent_start", (_event, ctx) => {
    state.ctx = ctx;
  });
}
