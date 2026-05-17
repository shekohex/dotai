import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

import { createTextComponent } from "../coreui/tools.js";
import { executeInterviewTool } from "./execute.js";
import { renderInterviewResult } from "./render.js";

const InterviewParams = Type.Object({
  questions: Type.String({
    description:
      "Inline JSON string with questions, or path to questions JSON / saved interview HTML file",
  }),
  timeout: Type.Optional(Type.Number({ description: "Seconds before auto-timeout", default: 600 })),
  verbose: Type.Optional(Type.Boolean({ description: "Enable debug logging", default: false })),
  theme: Type.Optional(
    Type.Object(
      {
        mode: Type.Optional(StringEnum(["auto", "light", "dark"])),
        name: Type.Optional(Type.String()),
        lightPath: Type.Optional(Type.String()),
        darkPath: Type.Optional(Type.String()),
        toggleHotkey: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  ),
});

type InterviewParamsValue = Static<typeof InterviewParams>;

const INTERVIEW_DESCRIPTION =
  "Present interactive form to gather user responses. " +
  "Runs in browser and returns structured responses to agent. " +
  "Use proactively when: choosing between multiple approaches, gathering requirements before implementation, " +
  "exploring design tradeoffs, or when decisions have multiple dimensions worth discussing. " +
  "Provides better UX than back-and-forth chat for structured input. " +
  "Image responses and attachments are returned as file paths - use read tool directly to display them. " +
  "Pass questions as inline JSON string directly (preferred) or as path to JSON file. " +
  'Questions JSON format: { "title": "...", "description": "...", "questions": [{ "id": "q1", "type": "single|multi|text|image|info", "question": "...", "options": ["A", "B"], "content": { "source": "...", "lang": "ts" }, "media": { "type": "image|chart|mermaid|table|html", ... } }] }. ' +
  "Options can be strings or objects: { label: string, content?: { source, lang?, file?, lines?, highlights?, title?, showSource? } }. " +
  "Always set recommended with context explaining your reasoning. Recommended options show Recommended badge and are pre-selected for user. " +
  'Use conviction: "slight" when unsure (does NOT pre-select), conviction: "strong" when very confident (shows Recommended badge). ' +
  "Omit conviction for normal recommendations (pre-selects). " +
  'Use weight: "critical" for key decisions (visually prominent), weight: "minor" for low-stakes questions (compact card). ' +
  "When questions have recommendations, set description to guide review (for example: Review my suggestions and adjust as needed). " +
  'Questions can have content field to display code or markdown above options. lang: "md" or "markdown" defaults to markdown preview unless showSource is true. Types: single (radio), multi (checkbox), text (textarea), image (file upload), info (non-interactive). ' +
  'Media blocks: { type: "image", src, alt, caption }, { type: "table", table: { headers, rows, highlights }, caption }, { type: "chart", chart: { type, data, options }, caption }, { type: "mermaid", mermaid: "graph LR\\n..." }, { type: "html", html }. ' +
  "Info type is non-interactive content panel for displaying context with media. Media position: above (default), below, side (two-column).";

function activateTool(pi: ExtensionAPI, toolName: string): void {
  const activeTools = new Set([...pi.getActiveTools(), toolName]);
  pi.setActiveTools(Array.from(activeTools).toSorted((left, right) => left.localeCompare(right)));
}

function deactivateTool(pi: ExtensionAPI, toolName: string): void {
  pi.setActiveTools(pi.getActiveTools().filter((activeToolName) => activeToolName !== toolName));
}

function registerInterviewTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "interview",
    label: "Interview",
    renderShell: "self",
    description: INTERVIEW_DESCRIPTION,
    promptSnippet:
      "Gather structured user input through interactive form for requirements, tradeoffs, or multi-dimensional decisions.",
    parameters: InterviewParams,
    execute(_toolCallId, params: InterviewParamsValue, signal, onUpdate, ctx) {
      return executeInterviewTool(params, signal, onUpdate, ctx);
    },
    renderCall(_args, _theme, context) {
      return createTextComponent(context.lastComponent, "");
    },
    renderResult(result, options, theme, context) {
      return renderInterviewResult(result, options, theme, context);
    },
  });
}

export default function registerInterviewExtension(pi: ExtensionAPI): void {
  let toolRegistered = false;
  let toolEnabled = false;

  const enableTool = (ctx?: ExtensionCommandContext): void => {
    if (!toolRegistered) {
      registerInterviewTool(pi);
      toolRegistered = true;
    }
    toolEnabled = true;
    activateTool(pi, "interview");
    ctx?.ui.notify("Interview tool enabled.");
  };

  const disableTool = (ctx?: ExtensionCommandContext): void => {
    toolEnabled = false;
    deactivateTool(pi, "interview");
    ctx?.ui.notify("Interview tool disabled.");
  };

  pi.registerCommand("interview", {
    description: "Toggle structured interview forms. Usage: /interview [on|off]",
    getArgumentCompletions(prefix) {
      return [
        { value: "on", label: "on", description: "Enable interview tool for agent turns" },
        { value: "off", label: "off", description: "Disable interview tool for agent turns" },
      ].filter((item) => item.value.startsWith(prefix.trim()));
    },
    handler(args, ctx) {
      const trimmed = args.trim();
      if (trimmed === "off") {
        disableTool(ctx);
        return Promise.resolve();
      }
      if (trimmed === "on") {
        enableTool(ctx);
        return Promise.resolve();
      }
      if (trimmed === "") {
        if (toolEnabled) {
          disableTool(ctx);
        } else {
          enableTool(ctx);
        }
        return Promise.resolve();
      }
      ctx.ui.notify("Usage: /interview [on|off]", "error");
      return Promise.resolve();
    },
  });

  pi.on("before_agent_start", () => {
    if (!toolEnabled) {
      deactivateTool(pi, "interview");
    }
  });
}
