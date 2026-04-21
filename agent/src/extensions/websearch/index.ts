import { StringEnum } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatToolRail } from "../coreui/tools.js";
import {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  WEBSEARCH_MODELS,
  parseWebSearchDetails,
  type ToolTheme,
} from "./types.js";
import { createWebSearchRequest, executeWebSearchRequest } from "./execution.js";
import { getAssistantText, getTextContent, formatDurationHuman } from "./parsing.js";
import {
  createTextComponent,
  getElapsedMs,
  renderWebSearchCompleteResult,
  renderWebSearchErrorResult,
  renderWebSearchPartialResult,
  syncRenderState,
} from "./render.js";

export const webSearchTool = defineTool({
  name: "websearch",
  label: "google",
  renderShell: "self",
  description:
    "Search the web with Google Search grounding via Gemini and return an answer with sources.",
  promptSnippet:
    "Search the live web with Google grounding when the task needs fresh or external information",
  promptGuidelines: [
    "Use this tool when the task needs fresh web data, release notes, official docs, or verification against external sources.",
    "Prefer primary sources and use returned citations in the final answer when the user asks for evidence or references.",
    "Use `websearch` tool instead of guessing whenever correctness depends on current or externally verifiable information.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "Search query or question to answer from the web" }),
    model: Type.Optional(
      StringEnum(WEBSEARCH_MODELS, {
        description: `Gemini model for grounded search. Default: ${DEFAULT_MODEL}`,
        default: DEFAULT_MODEL,
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        minimum: MIN_TIMEOUT_MS,
        maximum: MAX_TIMEOUT_MS,
        description: `Request timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}`,
      }),
    ),
  }),
  renderCall(args, theme, context) {
    syncRenderState(context, context.isPartial);
    const rail = formatToolRail(theme, context);
    let status = theme.bold(theme.fg("dim", "googling"));
    if (context.isError) {
      status = theme.bold(theme.fg("error", "googled"));
    } else if (!context.isPartial) {
      status = theme.bold(theme.fg("dim", "googled"));
    }
    const query =
      typeof args.query === "string" && args.query.trim().length > 0 ? args.query.trim() : "...";
    const modelName = args.model ?? DEFAULT_MODEL;
    const timeout =
      typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
        ? Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(args.timeoutMs)))
        : DEFAULT_TIMEOUT_MS;
    return createTextComponent(
      context.lastComponent,
      `${rail}${status} ${theme.fg("muted", query)}${theme.fg("muted", ` (${modelName} • ${formatDurationHuman(timeout)})`)}`,
    );
  },
  renderResult(result, { expanded, isPartial }, theme, context) {
    const state = syncRenderState(context, isPartial);
    const rail = formatToolRail(theme, context);
    const details = parseWebSearchDetails(result.details);
    const answer = (details?.answer ?? getTextContent(result.content)).trim();
    const durationMs = details?.durationMs ?? getElapsedMs(state);
    const toolTheme: ToolTheme = { fg: (color, text) => theme.fg(color, text) };

    if (context.isError) {
      return renderWebSearchErrorResult(expanded, context.lastComponent, rail, answer, toolTheme);
    }
    if (isPartial) {
      return renderWebSearchPartialResult(
        expanded,
        context.lastComponent,
        rail,
        answer,
        durationMs,
        toolTheme,
      );
    }
    return renderWebSearchCompleteResult(
      expanded,
      context.lastComponent,
      rail,
      answer,
      details,
      durationMs,
      toolTheme,
    );
  },
  execute(_toolCallId, params, _signal, onUpdate, ctx) {
    const request = createWebSearchRequest(params, onUpdate);
    return executeWebSearchRequest(request, onUpdate, ctx);
  },
});

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool(webSearchTool);
}

export { getAssistantText };
