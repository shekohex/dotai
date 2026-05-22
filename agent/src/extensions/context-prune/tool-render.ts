import type { Text } from "@earendil-works/pi-tui";
import { createTextComponent } from "../coreui/tools-render.js";
import { formatToolRail, formatToolStatus } from "../coreui/tools-status.js";

type ToolTheme = {
  fg: (
    token: "error" | "muted" | "borderAccent" | "borderMuted" | "text" | "dim",
    value: string,
  ) => string;
  bold: (value: string) => string;
  italic: (value: string) => string;
};

interface ToolRenderContext {
  isPartial: boolean;
  isError: boolean;
  lastComponent: unknown;
}

interface ContextPruneResultDetails {
  ok?: boolean;
  reason?: string;
  toolCallCount?: number;
  batchCount?: number;
  rawCharCount?: number;
  summaryCharCount?: number;
}

interface ContextTreeQueryArgs {
  toolCallIds?: string[];
}

interface ContextTreeQueryDetails {
  results?: Record<string, unknown>;
}

export function renderContextPruneCall(
  _args: object,
  theme: ToolTheme,
  context: ToolRenderContext,
): Text {
  return renderLine(
    theme,
    context,
    "Pruning",
    "Pruned",
    "Prune failed",
    "context",
    "summarizing tool history",
  );
}

export function renderContextPruneResult(
  result: { details?: unknown },
  _options: object,
  theme: ToolTheme,
  context: ToolRenderContext,
): Text {
  const details = readPruneResultDetails(result.details);
  const detail = details.ok === false ? (details.reason ?? "failed") : pruneResultDetail(details);
  return renderLine(theme, context, "Pruning", "Pruned", "Prune failed", "context", detail);
}

export function renderContextTreeQueryCall(
  args: ContextTreeQueryArgs,
  theme: ToolTheme,
  context: ToolRenderContext,
): Text {
  const count = args.toolCallIds?.length ?? 0;
  return renderLine(
    theme,
    context,
    "Querying",
    "Queried",
    "Query failed",
    "pruned outputs",
    `${count} ref${count === 1 ? "" : "s"}`,
  );
}

export function renderContextTreeQueryResult(
  result: { details?: unknown },
  _options: object,
  theme: ToolTheme,
  context: ToolRenderContext,
): Text {
  const details = readTreeQueryDetails(result.details);
  const count = Object.keys(details.results ?? {}).length;
  return renderLine(
    theme,
    context,
    "Querying",
    "Queried",
    "Query failed",
    "pruned outputs",
    `${count} found`,
  );
}

function readPruneResultDetails(value: unknown): ContextPruneResultDetails {
  return typeof value === "object" && value !== null ? value : {};
}

function readTreeQueryDetails(value: unknown): ContextTreeQueryDetails {
  return typeof value === "object" && value !== null ? value : {};
}

function pruneResultDetail(result: ContextPruneResultDetails): string {
  if (result.reason === "skipped-oversized") return "summary larger than raw output";
  if (result.reason === "skipped-undersized") return "raw output below threshold";
  const calls = result.toolCallCount ?? 0;
  const batches = result.batchCount ?? 0;
  return `${calls} tool call${calls === 1 ? "" : "s"}, ${batches} batch${batches === 1 ? "" : "es"}`;
}

function renderLine(
  theme: ToolTheme,
  context: ToolRenderContext,
  pending: string,
  success: string,
  error: string,
  subject: string,
  detail: string,
): Text {
  const status = formatToolStatus(theme, context, { pending, success, error });
  const text = `${formatToolRail(theme, context)}${status} ${theme.fg("text", subject)} ${theme.fg("dim", `· ${detail}`)}`;
  return createTextComponent(context.lastComponent, text);
}
