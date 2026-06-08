import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createToolStateEntry,
  readToolState,
  TOOL_STATE_ENTRY_TYPE,
} from "../../utils/tool-state.js";
import { createSessionQueryRequest, executeSessionQueryRequest } from "./execution.js";
import { renderSessionQueryCall, renderSessionQueryResult } from "./render.js";
import { getSessionQuerySettings } from "./settings.js";
import {
  isSessionQueryToolEnabled,
  SESSION_QUERY_TOOL_NAME,
  setSessionQueryToolEnabled,
} from "./state.js";

export const sessionQueryTool = defineTool({
  name: SESSION_QUERY_TOOL_NAME,
  label: "query",
  renderShell: "self",
  description:
    "Query a previous pi session file for context, decisions, or information. Use when you need to look up what happened in a parent session or any other session.",
  parameters: Type.Object({
    sessionPath: Type.String({
      description:
        "Full path to the session file (e.g., /home/user/.pi/agent/sessions/.../session.jsonl)",
    }),
    question: Type.String({
      description:
        "What you want to know about that session (e.g., 'What files were modified?' or 'What approach was chosen?')",
    }),
  }),
  renderCall(args, theme, context) {
    return renderSessionQueryCall(args, theme, context);
  },
  renderResult(result, state, theme, context) {
    return renderSessionQueryResult(result, state, theme, context);
  },
  execute(toolCallId, params, signal, onUpdate, ctx) {
    void toolCallId;
    const request = createSessionQueryRequest(params);
    return executeSessionQueryRequest(request, signal, onUpdate, ctx);
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(sessionQueryTool);

  const activateTool = (): void => {
    setSessionQueryToolEnabled(true);
    const activeTools = new Set([...pi.getActiveTools(), SESSION_QUERY_TOOL_NAME]);
    pi.setActiveTools(Array.from(activeTools).toSorted((left, right) => left.localeCompare(right)));
  };
  const deactivateTool = (): void => {
    setSessionQueryToolEnabled(false);
    pi.setActiveTools(
      pi.getActiveTools().filter((toolName) => toolName !== SESSION_QUERY_TOOL_NAME),
    );
  };
  const persistToolState = (): void => {
    pi.appendEntry(
      TOOL_STATE_ENTRY_TYPE,
      createToolStateEntry(SESSION_QUERY_TOOL_NAME, isSessionQueryToolEnabled()),
    );
  };
  const setEnabled = (enabled: boolean, options?: { persist?: boolean }): void => {
    if (enabled) activateTool();
    else deactivateTool();
    if (options?.persist === true) persistToolState();
  };
  const restoreToolState = (ctx: ExtensionContext): void => {
    const restored = readToolState(ctx.sessionManager.getBranch(), SESSION_QUERY_TOOL_NAME);
    setEnabled(restored ?? getSessionQuerySettings().enabled);
  };

  pi.registerCommand("session-query", {
    description:
      "Enable, disable, or show session_query tool status. Usage: /session-query on|off|status",
    getArgumentCompletions(prefix) {
      const trimmed = prefix.trim();
      return [
        { value: "on", label: "on", description: "Enable session_query tool for this session" },
        { value: "off", label: "off", description: "Disable session_query tool for this session" },
        { value: "status", label: "status", description: "Show session_query tool status" },
      ].filter((item) => item.value.startsWith(trimmed));
    },
    handler(args, ctx) {
      const command = args.trim();
      if (command === "on") {
        setEnabled(true, { persist: true });
        ctx.ui.notify("session_query tool enabled.", "info");
        return Promise.resolve();
      }
      if (command === "off") {
        setEnabled(false, { persist: true });
        ctx.ui.notify("session_query tool disabled.", "info");
        return Promise.resolve();
      }
      if (command === "status" || command === "") {
        const configEnabled = getSessionQuerySettings().enabled;
        ctx.ui.notify(
          `session_query: ${isSessionQueryToolEnabled() ? "enabled" : "disabled"} (config default: ${configEnabled ? "enabled" : "disabled"})`,
          "info",
        );
        return Promise.resolve();
      }
      ctx.ui.notify("Usage: /session-query on|off|status", "warning");
      return Promise.resolve();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    restoreToolState(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    restoreToolState(ctx);
  });
  pi.on("before_agent_start", () => {
    if (!isSessionQueryToolEnabled()) deactivateTool();
  });
}
