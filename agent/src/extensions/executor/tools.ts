import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  defineTool,
  getMarkdownTheme,
  highlightCode,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import type { JsonObject, JsonValue } from "./http.js";
import type { ResumeAction, ExecutorMcpInspection } from "./mcp-client.js";
import { inspectExecutorMcp, withExecutorMcpClient } from "./mcp-client.js";
import {
  buildExecutorSystemPrompt,
  parseJsonContent,
  toToolResult,
  type ExecuteToolDetails,
  type ExecuteToolResult,
} from "./executor-adapter.js";
import { openBrowserTarget } from "./browser.js";
import { resolveExecutorEndpoint } from "./connection.js";
import { connectExecutor } from "./status.js";
import {
  countTextLines,
  applyLinePrefix,
  createTextComponent,
  formatDurationHuman,
  formatToolRail,
  getTextContent,
  renderStreamingPreview,
  styleToolOutput,
  summarizeLineCount,
} from "../coreui/tools.js";

const DEFAULT_EXECUTE_DESCRIPTION =
  "Execute TypeScript in a sandboxed runtime with access to configured API tools.";

const DEFAULT_RESUME_DESCRIPTION = [
  "Resume a paused execution using the executionId returned by execute.",
  "Never call this without user approval unless they explicitly state otherwise.",
].join("\n");

const jsonStringSchema = Type.String({ description: "Optional JSON-encoded response content" });
const EXECUTE_STREAM_TAIL_LINES = 5;
const EXECUTE_SUMMARY_LINE_LIMIT = 80;
const TOOL_TEXT_PADDING_X = 0;
const TOOL_TEXT_PADDING_Y = 0;
const EXECUTE_TAB_WIDTH = 2;

const inspectionCache = new Map<string, Promise<ExecutorMcpInspection | undefined>>();

const executeToolParams = Type.Object({
  description: Type.String({
    description: "Clear, concise description of what this code does in 5-10 words.",
  }),
  code: Type.String({ description: "JavaScript code to execute" }),
});

type ExecuteToolInput = {
  description: string;
  code: string;
};

type ExecuteRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
  callComponent?: Text;
  callText?: string;
};

type ExecutorRenderTheme = Theme;
const ExecutorSearchResultItemSchema = Type.Object({
  path: Type.String(),
  name: Type.String(),
  description: Type.String(),
  sourceId: Type.String(),
  score: Type.Number(),
});

const ExecutorSearchResultsSchema = Type.Array(ExecutorSearchResultItemSchema, { minItems: 1 });

type ExecutorSearchResultItem = Static<typeof ExecutorSearchResultItemSchema>;

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasSchemaProperties = (schema: JsonObject | undefined): boolean => {
  if (!schema) {
    return false;
  }

  const properties = schema.properties;
  return isJsonObject(properties) && Object.keys(properties).length > 0;
};

const buildSchemaTemplate = (schema: JsonObject | undefined): JsonObject => {
  if (!schema) {
    return {};
  }

  const properties = schema.properties;
  if (!isJsonObject(properties)) {
    return {};
  }

  const template: JsonObject = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!isJsonObject(value)) {
      continue;
    }

    switch (value.type) {
      case "boolean":
        template[key] = false;
        break;
      case "number":
      case "integer":
        template[key] = 0;
        break;
      case "array":
        template[key] = [];
        break;
      case "object":
        template[key] = {};
        break;
      default:
        template[key] = "";
        break;
    }
  }

  return template;
};

const promptForInteraction = async (
  interaction: {
    mode: "form" | "url";
    message: string;
    requestedSchema?: JsonObject;
    url?: string;
  },
  ctx: ExtensionContext,
): Promise<{ action: ResumeAction; content?: JsonObject }> => {
  if (interaction.mode === "url" && interaction.url) {
    try {
      await openBrowserTarget(interaction.url);
      ctx.ui.notify(`Opened ${interaction.url}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Open this URL manually: ${interaction.url}\n\n${message}`, "warning");
    }

    const action = await ctx.ui.select(
      "Executor browser interaction",
      ["accept", "decline", "cancel"],
      { timeout: undefined },
    );
    return { action: (action as ResumeAction | undefined) ?? "cancel" };
  }

  if (!hasSchemaProperties(interaction.requestedSchema)) {
    const action = await ctx.ui.select("Executor interaction", ["accept", "decline", "cancel"], {
      timeout: undefined,
    });
    return { action: (action as ResumeAction | undefined) ?? "cancel" };
  }

  ctx.ui.notify(interaction.message, "info");
  const prefill = JSON.stringify(buildSchemaTemplate(interaction.requestedSchema), null, 2);
  const edited = await ctx.ui.editor("Executor response JSON", prefill);
  if (edited === undefined) {
    return { action: "cancel" };
  }

  const action = await ctx.ui.select("Submit Executor response", ["accept", "decline", "cancel"], {
    timeout: undefined,
  });
  const resolvedAction = (action as ResumeAction | undefined) ?? "cancel";
  if (resolvedAction !== "accept") {
    return { action: resolvedAction };
  }

  return {
    action: resolvedAction,
    content: parseJsonContent(edited),
  };
};

const buildInspectionCacheKey = (cwd: string, hasUI: boolean, mcpUrl: string): string =>
  `${cwd}:${hasUI ? "ui" : "headless"}:${mcpUrl}`;

const trimToUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const formatControlChar = (char: string): string =>
  `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;

const sanitizeDisplayText = (text: string): string => {
  const normalized = text.replace(/\r\n?/g, "\n");
  const sanitizedLines = normalized.split("\n").map((line) => {
    let output = "";
    let column = 0;

    for (const char of line) {
      if (char === "\t") {
        const remainder = column % EXECUTE_TAB_WIDTH;
        const spaces = remainder === 0 ? EXECUTE_TAB_WIDTH : EXECUTE_TAB_WIDTH - remainder;
        output += " ".repeat(spaces);
        column += spaces;
        continue;
      }

      if (
        (char >= "\u0000" && char <= "\u0008") ||
        char === "\u000b" ||
        char === "\u000c" ||
        (char >= "\u000e" && char <= "\u001f") ||
        char === "\u007f"
      ) {
        const escaped = formatControlChar(char);
        output += escaped;
        column += escaped.length;
        continue;
      }

      output += char;
      column += 1;
    }

    return output;
  });

  return sanitizedLines.join("\n");
};

const readStatusValue = (value: JsonValue | undefined): string | undefined => {
  if (!isJsonObject(value) || typeof value.status !== "string") {
    return undefined;
  }

  const normalized = value.status.replace(/[_-]+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
};

const readExecutionId = (details: ExecuteToolDetails | undefined): string | undefined =>
  typeof details?.executionId === "string" && details.executionId.length > 0
    ? details.executionId
    : undefined;

const tryParseJsonValue = (text: string | undefined): JsonValue | undefined => {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
};

const tryParseNestedJsonValue = (value: string | undefined, depth = 0): JsonValue | undefined => {
  if (!value || depth > 4) {
    return undefined;
  }

  const parsed = tryParseJsonValue(value);
  if (typeof parsed === "string") {
    return tryParseNestedJsonValue(parsed, depth + 1) ?? parsed;
  }

  return parsed;
};

const readTextField = (value: JsonValue | undefined): string | undefined => {
  if (!isJsonObject(value)) {
    return undefined;
  }

  for (const key of ["text", "output", "answer", "markdown", "message"]) {
    if (typeof value[key] === "string") {
      return value[key] as string;
    }
  }

  return undefined;
};

const readTextContentBlocks = (value: JsonValue | undefined): string | undefined => {
  if (!isJsonObject(value) || !Array.isArray(value.content)) {
    return undefined;
  }

  const text = value.content
    .filter(
      (item): item is JsonObject =>
        isJsonObject(item) && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text as string)
    .join("\n")
    .trim();

  return text.length > 0 ? text : undefined;
};

const unwrapExecutorPayload = (value: JsonValue | undefined): JsonValue | undefined => {
  let current = value;

  for (let depth = 0; depth < 5; depth++) {
    if (!isJsonObject(current)) {
      return current;
    }

    if ("result" in current) {
      current = current.result as JsonValue;
      continue;
    }

    if ("structuredContent" in current) {
      current = current.structuredContent as JsonValue;
      continue;
    }

    return current;
  }

  return current;
};

const extractExecutorDisplayValue = (result: {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}): {
  root?: JsonValue;
  structured?: JsonValue;
  text?: string;
} => {
  const root = readStructuredContent(result);
  const directText = getTextContent(result);
  const candidateValues = [
    unwrapExecutorPayload(root),
    unwrapExecutorPayload(tryParseNestedJsonValue(directText)),
  ];

  for (const candidate of candidateValues) {
    if (candidate === undefined) {
      continue;
    }

    const contentText = readTextContentBlocks(candidate);
    if (contentText) {
      const parsedContent = tryParseNestedJsonValue(contentText);
      if (parsedContent !== undefined) {
        return {
          root,
          structured: unwrapExecutorPayload(parsedContent) ?? parsedContent,
          text: contentText,
        };
      }
      return { root, text: contentText };
    }

    const textField = readTextField(candidate);
    if (textField) {
      const parsedField = tryParseNestedJsonValue(textField);
      if (parsedField !== undefined) {
        return {
          root,
          structured: unwrapExecutorPayload(parsedField) ?? parsedField,
          text: textField,
        };
      }
      return { root, text: textField };
    }

    return { root, structured: candidate };
  }

  const parsedText = tryParseNestedJsonValue(directText);
  if (parsedText !== undefined) {
    return { root, structured: unwrapExecutorPayload(parsedText) ?? parsedText, text: directText };
  }

  return directText ? { root, text: directText } : { root };
};

const formatValueKind = (value: JsonValue): string => {
  const searchResults = parseExecutorSearchResults(value);
  if (searchResults) {
    return `matches(${searchResults.length})`;
  }

  if (Array.isArray(value)) {
    return value.length === 0 ? "empty array" : `array(${value.length})`;
  }

  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "value";
  }
};

const trimTrailingEmptyLines = (lines: string[]): string[] => {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end);
};

const shouldDisplayDuration = (durationMs: number | undefined): durationMs is number =>
  typeof durationMs === "number" && durationMs >= 1000;

const limitLabelLength = (value: string, maxLength = EXECUTE_SUMMARY_LINE_LIMIT): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const summarizeCodeSnippet = (code: string): string => {
  const firstMeaningfulLine = code
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstMeaningfulLine ? limitLabelLength(firstMeaningfulLine) : "Executor script";
};

const readExecuteLabel = (args: Partial<ExecuteToolInput> | undefined): string => {
  const description = trimToUndefined(
    typeof args?.description === "string" ? args.description : undefined,
  );
  if (description) {
    return limitLabelLength(description);
  }

  return summarizeCodeSnippet(typeof args?.code === "string" ? args.code : "");
};

const readCode = (args: Partial<ExecuteToolInput> | undefined): string =>
  typeof args?.code === "string" ? args.code : "";

const readDuration = (
  details: ExecuteToolDetails | undefined,
  state: ExecuteRenderState,
): number | undefined =>
  typeof details?.durationMs === "number"
    ? details.durationMs
    : state.startedAt === undefined
      ? undefined
      : (state.endedAt ?? Date.now()) - state.startedAt;

const syncExecuteRenderState = (
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
): ExecuteRenderState => {
  const state = context.state as ExecuteRenderState;

  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }

  if (state.startedAt !== undefined && isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1000);
    state.interval.unref?.();
  }

  if (!isPartial && state.startedAt !== undefined) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  return state;
};

const setExecuteCallComponent = (
  state: ExecuteRenderState,
  lastComponent: unknown,
  text: string,
): Text => {
  const component = createTextComponent(state.callComponent ?? lastComponent, text);
  state.callComponent = component;
  state.callText = text;
  return component;
};

const appendCollapsedExecuteSummary = (state: ExecuteRenderState, suffix: string): void => {
  if (!(state.callComponent instanceof Text) || !state.callText || !suffix) {
    return;
  }

  state.callComponent.setText(`${state.callText}${suffix}`);
};

const renderHighlightedLines = (
  source: string,
  language: string,
  _theme: ExecutorRenderTheme,
): string[] => trimTrailingEmptyLines(highlightCode(sanitizeDisplayText(source), language));

const formatCollapsedCodePreview = (
  lines: string[],
  footer: string,
  theme: ExecutorRenderTheme,
): string => {
  const visibleLines = lines.slice(-EXECUTE_STREAM_TAIL_LINES);
  const earlierLineCount = Math.max(lines.length - visibleLines.length, 0);
  const blocks: string[] = [];

  if (earlierLineCount > 0) {
    blocks.push(
      `${theme.fg("dim", "↳ ")}${theme.fg("muted", `... (${earlierLineCount} earlier lines)`)}`,
    );
  }

  if (visibleLines.length > 0) {
    blocks.push(visibleLines.join("\n"));
  }

  blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", footer)}`);
  return blocks.join("\n");
};

const formatExecuteCallHeader = (
  args: Partial<ExecuteToolInput> | undefined,
  theme: ExecutorRenderTheme,
  phase: "pending" | "success" | "error",
): string => {
  const status =
    phase === "error"
      ? theme.bold(theme.fg("error", "execute"))
      : phase === "success"
        ? theme.bold(theme.fg("muted", "executed"))
        : theme.italic(theme.fg("muted", "executing"));
  const label = readExecuteLabel(args);
  const lineCount = countTextLines(readCode(args));
  const suffix = lineCount > 0 ? theme.fg("muted", ` · ${summarizeLineCount(lineCount)}`) : "";
  return `${status} ${theme.fg("text", label)}${suffix}`;
};

const resolveStatusColor = (
  status: string | undefined,
  theme: ExecutorRenderTheme,
  isError: boolean,
): ((text: string) => string) => {
  if (isError) {
    return (text) => theme.fg("error", text);
  }

  const normalized = status?.toLowerCase().trim();
  if (!normalized) {
    return (text) => theme.fg("muted", text);
  }

  if (
    ["completed", "complete", "success", "succeeded", "done", "ok", "accepted"].includes(normalized)
  ) {
    return (text) => theme.fg("success", text);
  }

  if (
    ["executing", "running", "waiting", "waiting for interaction", "pending", "paused"].includes(
      normalized,
    )
  ) {
    return (text) => theme.fg("warning", text);
  }

  if (["failed", "error", "cancelled", "declined"].includes(normalized)) {
    return (text) => theme.fg("error", text);
  }

  return (text) => theme.fg("muted", text);
};

const isExecutorSearchResults = (
  value: JsonValue | undefined,
): value is ExecutorSearchResultItem[] =>
  value !== undefined && Value.Check(ExecutorSearchResultsSchema, value);

const parseExecutorSearchResults = (
  value: JsonValue | undefined,
): ExecutorSearchResultItem[] | undefined => {
  if (!isExecutorSearchResults(value)) {
    return undefined;
  }

  return Value.Parse(ExecutorSearchResultsSchema, value);
};

const formatExecutorSearchResultsMarkdown = (items: ExecutorSearchResultItem[]): string =>
  items
    .map((item, index) => {
      const section = [
        `### ${index + 1}. ${item.name}`,
        `- Path: \`${item.path}\``,
        `- Source: \`${item.sourceId}\``,
        `- Score: \`${item.score}\``,
        "",
        item.description.trim(),
      ];
      return section.join("\n");
    })
    .join("\n\n---\n\n");

const readStructuredContent = (result: {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}): JsonValue | undefined => {
  const details = result.details as ExecuteToolDetails | undefined;
  if (details && "structuredContent" in details) {
    return details.structuredContent;
  }

  const text = getTextContent(result as { content: Array<{ type: string; text?: string }> });
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
};

const formatStructuredJson = (value: JsonValue, theme: ExecutorRenderTheme): string =>
  renderHighlightedLines(sanitizeDisplayText(JSON.stringify(value, null, 2)), "json", theme).join(
    "\n",
  );

const formatExecutorTextOutput = (text: string, theme: ExecutorRenderTheme): string => {
  if (!text) {
    return "";
  }

  try {
    return formatStructuredJson(JSON.parse(text) as JsonValue, theme);
  } catch {
    return styleToolOutput(sanitizeDisplayText(text), theme);
  }
};

const buildExecuteSummary = (
  details: ExecuteToolDetails | undefined,
  text: string,
  durationMs: number | undefined,
  theme: ExecutorRenderTheme,
  isError: boolean,
): string => {
  const displayValue = extractExecutorDisplayValue({ content: [{ type: "text", text }], details });
  const structured = displayValue.structured;
  const displayText = displayValue.text ?? text;
  const status = isError
    ? "failed"
    : (readStatusValue(displayValue.root) ??
      readStatusValue(structured) ??
      (structured !== undefined ? "completed" : displayText ? "returned" : "done"));
  const statusColor = resolveStatusColor(status, theme, isError);
  const parts = [statusColor(status)];

  if (!isError && structured !== undefined) {
    parts.push(theme.fg("muted", formatValueKind(structured)));
  } else if (!structured && displayText) {
    parts.push(theme.fg("muted", summarizeLineCount(countTextLines(displayText))));
  }

  const executionId = readExecutionId(details);
  if (executionId) {
    parts.push(theme.fg("muted", executionId));
  }

  if (shouldDisplayDuration(durationMs)) {
    parts.push(theme.fg("muted", `took ${formatDurationHuman(durationMs)}`));
  }

  return parts.join(`${theme.fg("muted", " · ")}`);
};

const renderExpandedExecuteResult = (
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  details: ExecuteToolDetails | undefined,
  theme: ExecutorRenderTheme,
  lastComponent: unknown,
  summary: string,
  isError: boolean,
): Container => {
  const displayValue = extractExecutorDisplayValue(result);
  const structured = displayValue.structured;
  const text = displayValue.text ?? getTextContent(result);
  const container = lastComponent instanceof Container ? lastComponent : new Container();
  container.clear();

  if (text) {
    const plainJson =
      structured !== undefined ? JSON.stringify(structured, null, 2).trim() : undefined;
    const shouldShowText = !plainJson || plainJson !== text.trim();
    if (shouldShowText) {
      container.addChild(
        new Text(formatExecutorTextOutput(text, theme), TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y),
      );
    }
  }

  if (structured !== undefined) {
    const searchResults = parseExecutorSearchResults(structured);
    if (searchResults) {
      if (text) {
        container.addChild(new Spacer(1));
      }
      container.addChild(
        new Markdown(
          formatExecutorSearchResultsMarkdown(searchResults),
          TOOL_TEXT_PADDING_X,
          TOOL_TEXT_PADDING_Y,
          getMarkdownTheme(),
        ),
      );
    } else {
      if (text) {
        container.addChild(new Spacer(1));
      }
      container.addChild(
        new Text(formatStructuredJson(structured, theme), TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y),
      );
    }
  }

  if (!text && structured === undefined) {
    container.addChild(
      new Text(
        isError
          ? theme.fg("error", "Executor returned no output.")
          : theme.fg("muted", "Executor returned no output."),
        TOOL_TEXT_PADDING_X,
        TOOL_TEXT_PADDING_Y,
      ),
    );
  }

  if (structured !== undefined && !parseExecutorSearchResults(structured)) {
    return appendSummaryToExpandedContainer(container, theme, summary);
  }

  return appendSummaryToExpandedContainer(container, theme, summary);
};

const appendSummaryToExpandedContainer = (
  container: Container,
  theme: ExecutorRenderTheme,
  summary: string,
): Container => {
  container.addChild(new Spacer(1));
  container.addChild(
    new Text(`${theme.fg("dim", "↳ ")}${summary}`, TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y),
  );
  return container;
};

const readInspectedToolDescription = (
  inspection: ExecutorMcpInspection | undefined,
  toolName: string,
): string | undefined =>
  trimToUndefined(inspection?.tools.find((tool) => tool.name === toolName)?.description) ??
  (toolName === "execute" ? trimToUndefined(inspection?.instructions) : undefined);

const inspectConfiguredExecutor = async (
  cwd: string,
  hasUI: boolean,
): Promise<ExecutorMcpInspection | undefined> => {
  let endpoint;
  try {
    endpoint = await resolveExecutorEndpoint();
  } catch {
    return undefined;
  }

  const cacheKey = buildInspectionCacheKey(cwd, hasUI, endpoint.mcpUrl);
  const cached = inspectionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const inspectionPromise = (async (): Promise<ExecutorMcpInspection | undefined> => {
    try {
      return await inspectExecutorMcp(endpoint.mcpUrl, hasUI);
    } catch {
      return undefined;
    }
  })();

  inspectionCache.set(cacheKey, inspectionPromise);

  try {
    return await inspectionPromise;
  } catch {
    inspectionCache.delete(cacheKey);
    return undefined;
  }
};

const loadExecutorDescriptions = async (
  cwd: string,
  hasUI: boolean,
): Promise<{ executeDescription: string; resumeDescription: string }> => {
  const inspection = await inspectConfiguredExecutor(cwd, hasUI);

  return {
    executeDescription:
      readInspectedToolDescription(inspection, "execute") ?? DEFAULT_EXECUTE_DESCRIPTION,
    resumeDescription:
      readInspectedToolDescription(inspection, "resume") ?? DEFAULT_RESUME_DESCRIPTION,
  };
};

export const createExecuteToolDefinition = (pi: ExtensionAPI, description: string) =>
  defineTool<typeof executeToolParams, ExecuteToolDetails, ExecuteRenderState>({
    name: "execute",
    label: "Execute",
    renderShell: "self",
    description,
    promptSnippet: "Execute TypeScript in Executor's sandboxed runtime with configured API tools.",
    promptGuidelines: [
      "Search inside execute before calling Executor tools directly in code.",
      "Use execute instead of top-level helper tools for Executor discovery and invocation.",
      "load the `executor` skill first before using this tool, it will explain it in details and how to use it",
    ],
    parameters: executeToolParams,
    renderCall(args, theme, context) {
      const state = syncExecuteRenderState(context, context.isPartial);
      const rail = formatToolRail(theme, context);
      const header = formatExecuteCallHeader(
        args,
        theme,
        context.isError ? "error" : context.isPartial ? "pending" : "success",
      );
      const code = readCode(args);
      let callText: string;

      if (!context.argsComplete && code) {
        const highlightedLines = renderHighlightedLines(code, "typescript", theme);
        const footer = `${summarizeLineCount(countTextLines(code))} so far`;
        const preview = context.expanded
          ? `${highlightedLines.join("\n")}\n${theme.fg("dim", "↳ ")}${theme.fg("muted", footer)}`
          : formatCollapsedCodePreview(highlightedLines, footer, theme);
        callText = `${header}\n${preview}`;
      } else if (context.expanded && code) {
        const highlightedCode = renderHighlightedLines(code, "typescript", theme).join("\n");
        callText = `${header}\n\n${highlightedCode}`;
      } else {
        callText = header;
      }

      return setExecuteCallComponent(state, context.lastComponent, applyLinePrefix(callText, rail));
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const state = syncExecuteRenderState(context, isPartial);
      const details = result.details as ExecuteToolDetails | undefined;
      const displayValue = extractExecutorDisplayValue(result);
      const text = displayValue.text ?? getTextContent(result);
      const durationMs = readDuration(details, state);
      const summary = buildExecuteSummary(details, text, durationMs, theme, context.isError);

      if (context.isError) {
        if (!expanded) {
          appendCollapsedExecuteSummary(state, `${theme.fg("muted", " · ")}${summary}`);
          return createTextComponent(context.lastComponent, "");
        }

        return renderExpandedExecuteResult(
          result,
          details,
          theme,
          context.lastComponent,
          summary,
          true,
        );
      }

      if (isPartial) {
        const structured = displayValue.structured;
        const previewText =
          structured !== undefined
            ? formatStructuredJson(structured, theme)
            : text
              ? formatExecutorTextOutput(text, theme)
              : "";
        const footer = summary;

        if (previewText) {
          return renderStreamingPreview(previewText, theme, context.lastComponent, {
            expanded,
            footer,
            tailLines: EXECUTE_STREAM_TAIL_LINES,
          });
        }

        return createTextComponent(
          context.lastComponent,
          `${formatToolRail(theme, context)}${theme.fg("dim", "↳ ")}${theme.fg("muted", summary)}`,
        );
      }

      if (!expanded) {
        appendCollapsedExecuteSummary(state, `${theme.fg("muted", " · ")}${summary}`);
        return createTextComponent(context.lastComponent, "");
      }

      return renderExpandedExecuteResult(
        result,
        details,
        theme,
        context.lastComponent,
        summary,
        false,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ExecuteToolResult> {
      const endpoint = await connectExecutor(pi, ctx);
      const startedAt = Date.now();

      const outcome = await withExecutorMcpClient(
        endpoint.mcpUrl,
        {
          hasUI: ctx.hasUI,
          onElicitation: ctx.hasUI
            ? (interaction) =>
                promptForInteraction(
                  interaction.mode === "url"
                    ? {
                        mode: "url",
                        message: interaction.message,
                        url: interaction.url,
                      }
                    : {
                        mode: "form",
                        message: interaction.message,
                        requestedSchema: interaction.requestedSchema,
                      },
                  ctx,
                )
            : undefined,
        },
        async (client) => client.execute(params.code),
      );

      return toToolResult(outcome, {
        baseUrl: endpoint.mcpUrl,
        scopeId: endpoint.scope.id,
        durationMs: Date.now() - startedAt,
      });
    },
  });

const buildResumeTool = (pi: ExtensionAPI, description: string) =>
  defineTool({
    name: "resume",
    label: "Resume",
    description,
    promptSnippet:
      "Resume a paused Executor execution after the user has completed the required interaction.",
    promptGuidelines: ["Use the exact executionId returned by execute."],
    parameters: Type.Object({
      executionId: Type.String({ description: "The execution ID from the paused result" }),
      action: Type.Union([Type.Literal("accept"), Type.Literal("decline"), Type.Literal("cancel")]),
      content: Type.Optional(jsonStringSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ExecuteToolResult> {
      const endpoint = await connectExecutor(pi, ctx);
      const startedAt = Date.now();

      const outcome = await withExecutorMcpClient(
        endpoint.mcpUrl,
        { hasUI: false },
        async (client) =>
          client.resume(
            params.executionId,
            params.action as ResumeAction,
            parseJsonContent(params.content),
          ),
      );

      return toToolResult(outcome, {
        baseUrl: endpoint.mcpUrl,
        scopeId: endpoint.scope.id,
        durationMs: Date.now() - startedAt,
      });
    },
  });

export const loadExecutorPrompt = async (cwd: string, hasUI: boolean): Promise<string> => {
  const { executeDescription } = await loadExecutorDescriptions(cwd, hasUI);
  return buildExecutorSystemPrompt(executeDescription, !hasUI);
};

export const isExecutorToolDetails = (value: object | null): value is ExecuteToolDetails => {
  if (!value || !("baseUrl" in value) || !("scopeId" in value) || !("isError" in value)) {
    return false;
  }

  return (
    typeof value.baseUrl === "string" &&
    typeof value.scopeId === "string" &&
    typeof value.isError === "boolean"
  );
};

export const createExecutorTools = async (
  pi: ExtensionAPI,
  cwd: string,
  hasUI: boolean,
): Promise<ToolDefinition[]> => {
  const { executeDescription, resumeDescription } = await loadExecutorDescriptions(cwd, hasUI);
  return hasUI
    ? [createExecuteToolDefinition(pi, executeDescription)]
    : [createExecuteToolDefinition(pi, executeDescription), buildResumeTool(pi, resumeDescription)];
};

export const registerExecutorTools = async (
  pi: ExtensionAPI,
  cwd: string,
  hasUI: boolean,
): Promise<void> => {
  for (const tool of await createExecutorTools(pi, cwd, hasUI)) {
    pi.registerTool(tool);
  }
};

export const clearExecutorInspectionCache = (): void => {
  inspectionCache.clear();
};
