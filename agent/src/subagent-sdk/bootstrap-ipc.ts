import type { ExtensionEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { connectSubagentIpcClient, SubagentIpcConfigSchema } from "./ipc.js";
import type { ChildBootstrapState } from "./types.js";

export function registerChildIpcBridge(pi: ExtensionAPI, childState: ChildBootstrapState): void {
  if (!Value.Check(SubagentIpcConfigSchema, childState.ipc)) {
    return;
  }
  const ipc = connectSubagentIpcClient({ sessionId: childState.sessionId, config: childState.ipc });
  const emit = (event: ExtensionEvent): void => {
    ipc.emit(event);
  };

  pi.on("resources_discover", emit);
  pi.on("session_start", emit);
  pi.on("session_before_switch", emit);
  pi.on("session_before_fork", emit);
  pi.on("session_before_compact", emit);
  pi.on("session_compact", emit);
  pi.on("session_before_tree", emit);
  pi.on("session_tree", emit);
  pi.on("context", emit);
  pi.on("before_provider_request", emit);
  pi.on("after_provider_response", emit);
  pi.on("before_agent_start", emit);
  pi.on("agent_start", emit);
  pi.on("agent_end", emit);
  pi.on("turn_start", emit);
  pi.on("turn_end", emit);
  pi.on("message_start", emit);
  pi.on("message_update", emit);
  pi.on("message_end", emit);
  pi.on("tool_execution_start", emit);
  pi.on("tool_execution_update", emit);
  pi.on("tool_execution_end", emit);
  pi.on("model_select", emit);
  pi.on("thinking_level_select", emit);
  pi.on("tool_call", emit);
  pi.on("tool_result", emit);
  pi.on("user_bash", emit);
  pi.on("input", emit);
  pi.on("session_shutdown", (event) => {
    ipc.emit(event);
    ipc.disposeAfterFlush();
  });
}
