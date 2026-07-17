import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isChildSession } from "../../subagent-sdk/bootstrap.js";
import { readChildState } from "../../subagent-sdk/launch.js";
import { rankSearchTools } from "./ranking.js";
import { renderSearchToolsCall, renderSearchToolsResult } from "./render.js";

export const SEARCH_TOOLS_TOOL_NAME = "search_tools";

export const DEFERRED_TOOL_NAMES = new Set([
  "ask_user_question",
  "execute",
  "generate_image",
  "goal",
  "session_query",
  "subagent",
  "workflow",
]);

export const SEARCH_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ask_user_question: ["ask user", "question", "clarify", "choice", "preference", "screenshot"],
  execute: ["executor", "integration", "api", "mcp", "openapi", "graphql"],
  generate_image: [
    "image",
    "draw",
    "illustration",
    "picture",
    "create image",
    "generate image",
    "edit image",
  ],
  goal: ["durable goal", "autonomous goal", "continue until complete"],
  session_query: [
    "previous session",
    "previous pi session",
    "previous pi sessions",
    "parent session",
    "session history",
    "sessions history",
    "conversation history",
    "past conversation",
    "prior conversation",
    "prior conversations",
  ],
  subagent: ["delegate", "delegation", "child agent", "parallel agent"],
  workflow: ["workflow", "fan out", "fanout", "multi agent", "orchestration", "parallel"],
};

const ModeToolRulesEventSchema = Type.Object(
  {
    spec: Type.Optional(
      Type.Object(
        {
          tools: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

export function modeAllowsDeferredTool(
  toolName: string,
  toolRules: readonly string[] | undefined,
): boolean {
  if (toolRules === undefined) return true;
  if (toolRules.includes(`!${toolName}`)) return false;
  return toolRules.includes("*") || toolRules.includes(toolName);
}

export function canLoadDeferredTool(
  toolName: string,
  toolRules: readonly string[] | undefined,
  childSession: boolean,
  childToolNames?: readonly string[],
): boolean {
  if (childSession && (toolName === "subagent" || toolName === "ask_user_question")) return false;
  if (childSession && childToolNames?.includes(toolName) !== true) return false;
  return modeAllowsDeferredTool(toolName, toolRules);
}

export function createSearchToolsToolDefinition(
  pi: ExtensionAPI,
  getActiveModeToolRules?: () => readonly string[] | undefined,
) {
  return defineTool({
    name: SEARCH_TOOLS_TOOL_NAME,
    label: "Search Tools",
    renderShell: "self",
    description: "Search for and enable optional tools relevant to the current task.",
    promptSnippet: "Search for additional tools when active tools cannot perform the task.",
    promptGuidelines: [
      "Use search_tools when the task needs an optional capability that is not currently available.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Capability or task to search for" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    renderCall(args, theme, context) {
      return renderSearchToolsCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderSearchToolsResult(result, options, theme, context);
    },
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const childState = readChildState();
      const childSession = isChildSession(childState, ctx);
      const candidates = pi
        .getAllTools()
        .filter((tool) => DEFERRED_TOOL_NAMES.has(tool.name))
        .filter((tool) =>
          canLoadDeferredTool(
            tool.name,
            getActiveModeToolRules?.(),
            childSession,
            childSession ? childState.tools : undefined,
          ),
        )
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          aliases: SEARCH_TOOL_ALIASES[tool.name] ?? [],
        }));
      const ranking = rankSearchTools(params.query, candidates, params.limit ?? 3);
      const activeTools = pi.getActiveTools();
      const added = ranking.matches.filter((name) => !activeTools.includes(name));
      const alreadyActive = ranking.matches.filter((name) => activeTools.includes(name));
      if (added.length > 0) {
        pi.setActiveTools([...new Set([...activeTools, ...added])]);
      }
      let text = `No tools found for: ${params.query}`;
      if (ranking.decision === "ambiguous") text = `Ambiguous tool matches for: ${params.query}`;
      else if (added.length > 0) text = `Loaded tools: ${added.join(", ")}`;
      else if (alreadyActive.length > 0) {
        text = `Matching tools already active: ${alreadyActive.join(", ")}`;
      }
      return Promise.resolve({
        content: [{ type: "text", text }],
        details: {
          ...ranking,
          added,
          alreadyActive,
        },
      });
    },
  });
}

export default function searchToolsExtension(pi: ExtensionAPI): void {
  let activeModeToolRules: readonly string[] | undefined;
  const unsubscribeModesChanged = pi.events.on?.("modes:changed", (event: unknown) => {
    if (!Value.Check(ModeToolRulesEventSchema, event)) return;
    activeModeToolRules = Value.Parse(ModeToolRulesEventSchema, event).spec?.tools;
  });

  pi.registerTool(createSearchToolsToolDefinition(pi, () => activeModeToolRules));
  pi.on("session_shutdown", () => {
    unsubscribeModesChanged?.();
  });
}
