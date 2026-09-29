import {
  highlightCode,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { getTextContent, styleToolOutput, summarizeLineCount } from "./tools-output.js";
import { applyLinePrefix, createTextComponent, renderStreamingPreview } from "./tools-render.js";
import { formatToolRail, formatToolStatus } from "./tools-status.js";

export type NativeToolKind = "codemode" | "tool-search" | "mcp";

const NativeToolPreviewArgsSchema = Type.Object({
  code: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
});

const NativeToolPreviewDetailsSchema = Type.Object({
  calls: Type.Optional(
    Type.Array(
      Type.Object({
        status: Type.Union([
          Type.Literal("running"),
          Type.Literal("ok"),
          Type.Literal("error"),
          Type.Literal("cancelled"),
        ]),
      }),
    ),
  ),
  loaded: Type.Optional(Type.Array(Type.String())),
});

type NativeToolRenderState = {
  startedAt?: number;
  endedAt?: number;
  summary?: string;
};

function formatNativeToolSummary(
  kind: NativeToolKind,
  details: unknown,
  isPartial: boolean,
): string {
  if (kind === "mcp") return isPartial ? "" : "1 call";
  if (!Value.Check(NativeToolPreviewDetailsSchema, details)) return "";
  if (kind === "tool-search" && details.loaded) {
    return `${details.loaded.length} tool${details.loaded.length === 1 ? "" : "s"}`;
  }
  if (!details.calls) return "";
  const completed = details.calls.filter((call) => call.status !== "running").length;
  if (isPartial) return `${completed}/${details.calls.length} calls`;
  return `${completed} call${completed === 1 ? "" : "s"}`;
}

function formatNativeToolDuration(state: NativeToolRenderState): string {
  if (state.startedAt === undefined) return "";
  const elapsedMs = Math.max(0, (state.endedAt ?? performance.now()) - state.startedAt);
  if (elapsedMs < 1000) return ` took ${Math.round(elapsedMs)}ms`;
  if (elapsedMs < 60_000) return ` took ${(elapsedMs / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  return ` took ${(elapsedMs / 60_000).toFixed(1).replace(/\.0$/, "")}min`;
}

const NATIVE_TOOL_VERBS = {
  codemode: { pending: "running", success: "ran", error: "run" },
  "tool-search": { pending: "searching", success: "searched", error: "search" },
  mcp: { pending: "calling", success: "called", error: "call" },
};

// Decorate registration so MCP reconnects and late server registrations retain styling.
export function styleNativeToolExtension(
  factory: ExtensionFactory,
  kind: NativeToolKind,
): ExtensionFactory {
  return (pi) =>
    factory({
      ...pi,
      registerTool: (tool) => {
        pi.registerTool(styleNativeToolDefinition(tool, kind));
      },
    } satisfies ExtensionAPI);
}

export function styleNativeToolDefinition<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  kind: NativeToolKind,
): ToolDefinition<TParams, TDetails, TState> {
  const renderStates = new Map<string, NativeToolRenderState>();
  return {
    ...tool,
    renderShell: "self",
    renderCall(args, theme, context) {
      const state = renderStates.get(context.toolCallId) ?? {};
      renderStates.set(context.toolCallId, state);
      if (context.executionStarted) state.startedAt ??= performance.now();
      const previewArgs: Static<typeof NativeToolPreviewArgsSchema> = Value.Check(
        NativeToolPreviewArgsSchema,
        args,
      )
        ? args
        : {};
      let label = tool.label;
      let suffix = "";
      let body = "";
      if (kind === "codemode") {
        const code = previewArgs.code ?? "";
        suffix = code ? ` · ${summarizeLineCount(code.split("\n").length)}` : "";
        if (context.expanded && code) body = highlightCode(code, "javascript").join("\n");
      } else if (kind === "tool-search") {
        label = `tools ${previewArgs.query ?? ""}`.trim();
      } else if (context.expanded) {
        body = highlightCode(JSON.stringify(args, null, 2) ?? "", "json").join("\n");
      }
      const rail = formatToolRail(theme, context);
      const status = formatToolStatus(theme, context, NATIVE_TOOL_VERBS[kind]);
      const heading = `${rail}${status} ${theme.fg("text", label.replaceAll(/\s+/g, " "))}`;
      const component = createTextComponent(context.lastComponent, "");
      return {
        render(width) {
          const summary =
            state.summary !== undefined && state.summary.length > 0
              ? ` · ${state.summary}`
              : suffix;
          const title = `${heading}${theme.fg("dim", `${summary}${formatNativeToolDuration(state)}`)}`;
          if (!context.expanded) return [truncateToWidth(title, width)];
          component.setText(body ? `${title}\n${body}` : title);
          return component.render(width);
        },
        invalidate: () => {
          component.invalidate();
        },
      };
    },
    renderResult(result, options, theme, context) {
      const state = renderStates.get(context.toolCallId) ?? {};
      renderStates.set(context.toolCallId, state);
      state.summary = formatNativeToolSummary(kind, result.details, options.isPartial);
      if (!options.isPartial) state.endedAt ??= performance.now();
      if (!options.expanded && !options.isPartial) {
        return createTextComponent(context.lastComponent, "");
      }
      if (!tool.renderResult) {
        const output = getTextContent(result);
        const styled = context.isError ? theme.fg("error", output) : styleToolOutput(output, theme);
        return renderStreamingPreview(
          applyLinePrefix(styled, theme.fg("dim", "↳ ")),
          theme,
          context.lastComponent,
          options,
        );
      }
      // Preserve native nested-call statuses, model costs, truncation notices and image hints.
      const nativeComponent = tool.renderResult(result, options, theme, {
        ...context,
        lastComponent: undefined,
      });
      return {
        render(width) {
          const lines = nativeComponent.render(Math.max(1, width - 2));
          while (lines.length > 0 && lines[0].trim() === "") lines.shift();
          const prefix = theme.fg("dim", "↳ ");
          return lines.map((line) =>
            line.trim() ? truncateToWidth(`${prefix}${line}`, width) : "",
          );
        },
        invalidate: () => {
          nativeComponent.invalidate();
        },
      };
    },
  };
}
