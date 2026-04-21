import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { readChildState } from "./launch.js";
import type { ChildBootstrapState } from "./types.js";
import {
  STRUCTURED_OUTPUT_SYSTEM_PROMPT,
  STRUCTURED_OUTPUT_TOOL_NAME,
  createChildBootstrapRuntimeState,
  isChildSession,
  isJsonSchemaOutputFormat,
  isTypeboxSchema,
} from "./bootstrap-core.js";
import { registerChildBootstrapHandlers } from "./bootstrap-handlers.js";

const bootstrapInstalledSymbol = Symbol.for("@shekohex/agent/subagent-sdk/bootstrap-installed");

type BootstrapAwareExtensionApi = ExtensionAPI & {
  [bootstrapInstalledSymbol]?: boolean;
};

export { isChildSession };

function registerStructuredOutputTool(
  pi: ExtensionAPI,
  childState: ChildBootstrapState,
  state: ReturnType<typeof createChildBootstrapRuntimeState>,
): void {
  if (!isJsonSchemaOutputFormat(childState)) {
    return;
  }
  if (!isTypeboxSchema(childState.outputFormat.schema)) {
    throw new Error("Child outputFormat.schema is not a valid TypeBox schema");
  }
  const structuredOutputTool = defineTool({
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    label: "SO",
    description:
      "Submit the final structured JSON response. Use this tool exactly once as the final action.",
    parameters: childState.outputFormat.schema,
    execute(_toolCallId, params) {
      state.turnStructuredCaptured = true;
      state.turnStructuredPayload = params;
      return Promise.resolve({
        content: [{ type: "text", text: "Structured output captured." }],
        details: { captured: true },
      });
    },
  });
  pi.registerTool(structuredOutputTool);
}

export function installChildBootstrap(pi: ExtensionAPI): void {
  const childState = readChildState();
  if (!childState) {
    return;
  }
  const bootstrapAwarePi = pi as BootstrapAwareExtensionApi;
  if (bootstrapAwarePi[bootstrapInstalledSymbol] === true) {
    return;
  }
  bootstrapAwarePi[bootstrapInstalledSymbol] = true;
  const state = createChildBootstrapRuntimeState(childState);
  registerStructuredOutputTool(pi, childState, state);
  registerChildBootstrapHandlers(pi, childState, state, STRUCTURED_OUTPUT_SYSTEM_PROMPT);
}
