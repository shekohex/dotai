import {
  editToolDefinition,
  keyHint,
  readToolDefinition,
  writeToolDefinition,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { shortenPathForTool } from "./path.js";

type ToolPathArgs = {
  path?: unknown;
  file_path?: unknown;
  offset?: unknown;
  limit?: unknown;
};

export function registerCoreUIToolOverrides(pi: ExtensionAPI): void {
  registerReadToolOverride(pi);
  registerEditToolOverride(pi);
  registerWriteToolOverride(pi);
}

function registerReadToolOverride(pi: ExtensionAPI): void {
  pi.registerTool({
    ...readToolDefinition,
    renderCall(args, theme, context) {
      const path = shortenPathForTool(readPathArg(args), context.cwd);
      const text =
        `${theme.fg("toolTitle", theme.bold("read"))} ` +
        `${theme.fg("accent", path || "...")}` +
        formatReadRangeSuffix(theme, args.offset, args.limit);

      return new Text(text, 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (!options.expanded) {
        return new Text(
          theme.fg("dim", `↳ ${keyHint("app.tools.expand", "to expand")}`),
          0,
          0,
        );
      }

      const textContent = result.content.find((part) => part.type === "text");
      if (!textContent || textContent.type !== "text") {
        return new Text("", 0, 0);
      }

      return delegateReadResult(result, options, theme, context, textContent.text);
    },
  });
}

function registerEditToolOverride(pi: ExtensionAPI): void {
  pi.registerTool({
    ...editToolDefinition,
    renderCall(args, theme, context) {
      if (context.expanded && editToolDefinition.renderCall) {
        return editToolDefinition.renderCall(args, theme, context);
      }

      return renderCompactPathToolCall("edit", readPathArg(args), theme, context.cwd);
    },
    renderResult(result, options, theme, context) {
      if (!options.expanded) {
        return new Text(
          theme.fg("dim", `↳ ${keyHint("app.tools.expand", "to expand")}`),
          0,
          0,
        );
      }

      if (editToolDefinition.renderResult) {
        return editToolDefinition.renderResult(result, options, theme, context);
      }

      return new Text("", 0, 0);
    },
  });
}

function registerWriteToolOverride(pi: ExtensionAPI): void {
  pi.registerTool({
    ...writeToolDefinition,
    renderCall(args, theme, context) {
      if (context.expanded && writeToolDefinition.renderCall) {
        return writeToolDefinition.renderCall(args, theme, context);
      }

      return renderCompactPathToolCall("write", readPathArg(args), theme, context.cwd);
    },
  });
}

function renderCompactPathToolCall(
  toolName: "edit" | "write",
  rawPath: string,
  theme: Parameters<NonNullable<typeof readToolDefinition.renderCall>>[1],
  cwd: string,
): Text {
  const path = shortenPathForTool(rawPath, cwd);
  const text =
    `${theme.fg("toolTitle", theme.bold(toolName))} ` +
    `${theme.fg("accent", path || "...")}` +
    `\n${theme.fg("dim", `↳ ${keyHint("app.tools.expand", "to expand")}`)}`;

  return new Text(text, 0, 0);
}

function delegateReadResult(
  result: Parameters<NonNullable<typeof readToolDefinition.renderResult>>[0],
  options: Parameters<NonNullable<typeof readToolDefinition.renderResult>>[1],
  theme: Parameters<NonNullable<typeof readToolDefinition.renderResult>>[2],
  context: Parameters<NonNullable<typeof readToolDefinition.renderResult>>[3],
  fallbackText: string,
) {
  if (readToolDefinition.renderResult) {
    return readToolDefinition.renderResult(result, options, theme, context);
  }

  return new Text(`\n${theme.fg("toolOutput", fallbackText)}`, 0, 0);
}

function readPathArg(args: ToolPathArgs): string {
  const value = args.file_path ?? args.path;
  return typeof value === "string" ? value : "";
}

function formatReadRangeSuffix(
  theme: Parameters<NonNullable<typeof readToolDefinition.renderCall>>[1],
  offset: unknown,
  limit: unknown,
): string {
  const startLine = typeof offset === "number" ? offset : undefined;
  const maxLines = typeof limit === "number" ? limit : undefined;

  if (startLine === undefined && maxLines === undefined) {
    return "";
  }

  const start = startLine ?? 1;
  const end = maxLines !== undefined ? start + maxLines - 1 : undefined;
  return theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
}
