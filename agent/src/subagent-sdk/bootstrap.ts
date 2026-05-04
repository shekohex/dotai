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
import { isStaleSessionReplacementContextError } from "../extensions/session-replacement.js";
import { createTextComponent } from "../extensions/coreui/tools-render.js";
import { asRecord } from "../utils/unknown-data.js";

const bootstrapInstalledSymbol = Symbol.for("@shekohex/agent/subagent-sdk/bootstrap-installed");

type BootstrapAwareExtensionApi = ExtensionAPI & {
  [bootstrapInstalledSymbol]?: boolean;
};

type StructuredOutputToolDetails = {
  captured: true;
  keys: string[];
};

export { isChildSession };

function listStructuredKeys(params: unknown): string[] {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return [];
  }
  return Object.keys(params).toSorted((left, right) => left.localeCompare(right));
}

function formatStructuredOutputSummary(keys: string[]): string {
  if (keys.length === 0) {
    return "captured";
  }
  if (keys.length <= 3) {
    return `captured ${keys.join(", ")}`;
  }
  return `captured ${keys.slice(0, 3).join(", ")} +${keys.length - 3}`;
}

function formatStructuredOutputJson(
  params: unknown,
  theme: { fg: (color: "toolOutput", text: string) => string },
): string {
  const json = JSON.stringify(params, null, 2) ?? "{}";
  return json
    .split("\n")
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");
}

function renderStructuredOutputCall(
  args: unknown,
  theme: { bold: (value: string) => string; fg: (color: "dim" | "muted", text: string) => string },
  context: { lastComponent: unknown; isPartial: boolean; isError: boolean },
) {
  const keys = listStructuredKeys(args);
  let verb = "so";
  if (context.isPartial) {
    verb = "saving";
  }
  return createTextComponent(
    context.lastComponent,
    `${theme.bold(theme.fg("dim", verb))} ${theme.fg("muted", keys.length > 0 ? `json · ${keys.length} keys` : "json")}`,
  );
}

function parseStructuredOutputToolDetails(value: unknown): StructuredOutputToolDetails | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const captured = record.captured;
  const keys = record.keys;
  if (captured !== true || !Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
    return undefined;
  }
  return { captured: true, keys };
}

function renderStructuredOutputResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: {
    bold: (value: string) => string;
    fg: (color: "dim" | "muted" | "error" | "toolOutput", text: string) => string;
  },
  context: { args: unknown; lastComponent: unknown; isError: boolean },
) {
  if (context.isError) {
    const message = result.content.find((part) => part.type === "text")?.text ?? "failed";
    return createTextComponent(context.lastComponent, theme.fg("error", `↳ ${message}`));
  }

  const details = parseStructuredOutputToolDetails(result.details);
  const keys = details?.keys ?? listStructuredKeys(context.args);
  const summary = `${theme.fg("dim", "↳ ")}${theme.fg("muted", formatStructuredOutputSummary(keys))}`;
  if (!options.expanded) {
    return createTextComponent(context.lastComponent, summary);
  }

  return createTextComponent(
    context.lastComponent,
    [summary, formatStructuredOutputJson(context.args, theme)].join("\n"),
  );
}

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
    renderShell: "self",
    description:
      "Submit the final structured JSON response. Use this tool exactly once as the final action.",
    parameters: childState.outputFormat.schema,
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      state.turnStructuredCaptured = true;
      state.turnStructuredPayload = params;
      state.capturedStructuredPayload = params;
      state.structuredCaptureInvalidated = false;
      state.lastTurnStructuredCaptured = true;
      state.lastTurnStructuredPayload = params;
      state.lastTurnStructuredValidationError = undefined;
      const keys = listStructuredKeys(params);
      state.shutdownRequested = true;
      try {
        ctx.shutdown();
      } catch (error) {
        if (!isStaleSessionReplacementContextError(error)) {
          throw error;
        }
      }
      return Promise.resolve({
        content: [{ type: "text", text: "Structured output captured." }],
        details: { captured: true, keys },
        terminate: true,
      });
    },
    renderCall: renderStructuredOutputCall,
    renderResult: renderStructuredOutputResult,
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
