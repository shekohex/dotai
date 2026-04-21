import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createSessionQueryRequest, executeSessionQueryRequest } from "./execution.js";
import { renderSessionQueryCall, renderSessionQueryResult } from "./render.js";

export const sessionQueryTool = defineTool({
  name: "session_query",
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
}
