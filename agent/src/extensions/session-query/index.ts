import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readToolState } from "../../utils/tool-state.js";
import { createSessionQueryRequest, executeSessionQueryRequest } from "./execution.js";
import { renderSessionQueryCall, renderSessionQueryResult } from "./render.js";
import { getSessionQuerySettings } from "./settings.js";
import { SESSION_QUERY_TOOL_NAME, setSessionQueryToolEnabled } from "./state.js";

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
  const setEnabled = (enabled: boolean): void => {
    if (enabled) activateTool();
    else deactivateTool();
  };
  const restoreToolState = (ctx: ExtensionContext): void => {
    const restored = readToolState(ctx.sessionManager.getBranch(), SESSION_QUERY_TOOL_NAME);
    setEnabled(restored ?? getSessionQuerySettings().enabled);
  };

  pi.on("session_start", (_event, ctx) => {
    restoreToolState(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    restoreToolState(ctx);
  });
}
