import type { ExtensionAPI, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  BACKGROUND_SHELL_COMPLETION_MESSAGE,
  BACKGROUND_SHELL_POLL_MESSAGE,
  type BackgroundShellMessageDetails,
  type BackgroundShellStatus,
} from "./tmux-background-types.js";

const POLL_MESSAGE_PREVIEW_LINES = 5;

const BackgroundShellMessageDetailsSchema = Type.Object({
  command: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  exitCode: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  outputFile: Type.Optional(Type.String()),
  pollLineCount: Type.Optional(Type.Number()),
  pollOmittedLineCount: Type.Optional(Type.Number()),
  status: Type.Optional(Type.String()),
  windowId: Type.Optional(Type.String()),
});

type ParsedMessageDetails = Static<typeof BackgroundShellMessageDetailsSchema>;

type MessageKind = "completion" | "poll";

type MessageTheme = Pick<Theme, "bg" | "bold" | "fg" | "italic">;

export function registerBackgroundShellMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(
    BACKGROUND_SHELL_COMPLETION_MESSAGE,
    createBackgroundShellMessageRenderer("completion"),
  );
  pi.registerMessageRenderer(
    BACKGROUND_SHELL_POLL_MESSAGE,
    createBackgroundShellMessageRenderer("poll"),
  );
}

function createBackgroundShellMessageRenderer(
  kind: MessageKind,
): MessageRenderer<BackgroundShellMessageDetails> {
  return (message, options, theme) => {
    const details = parseMessageDetails(message.details);
    const status = normalizeMessageStatus(details, kind);
    const marker = messageStatusMarker(status);
    const title = backgroundMessageTitle(details, kind, status);
    const titleTone = kind === "poll" ? "muted" : statusTone(status);
    const lines = [`${theme.fg(titleTone, marker)} ${theme.fg(titleTone, theme.bold(title))}`];
    const commandLine = formatNotificationCommandLine(details, theme, status, kind);
    if (commandLine !== undefined) lines.push(commandLine);
    if (kind === "poll" && typeof message.content === "string") {
      lines.push(...formatPollPreview(message.content, details, theme));
    } else if (options.expanded && typeof message.content === "string") {
      lines.push("", theme.fg("dim", message.content));
    }
    lines.push(...formatNotificationNotes(details, theme));
    const box = new Box(1, 1, (line) => theme.bg("userMessageBg", line));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  };
}

function parseMessageDetails(details: unknown): ParsedMessageDetails | undefined {
  if (!Value.Check(BackgroundShellMessageDetailsSchema, details)) return undefined;
  return Value.Parse(BackgroundShellMessageDetailsSchema, details);
}

function backgroundMessageTitle(
  details: ParsedMessageDetails | undefined,
  kind: MessageKind,
  status: BackgroundShellStatus,
): string {
  if (details?.description !== undefined && details.description.trim().length > 0) {
    return details.description.trim();
  }

  if (kind === "poll") return "background poll";
  return `background ${status}`;
}

function formatNotificationCommandLine(
  details: ParsedMessageDetails | undefined,
  theme: MessageTheme,
  status: BackgroundShellStatus,
  kind: MessageKind,
): string | undefined {
  if (details?.command === undefined) return undefined;

  const exitText =
    kind === "completion" && details.exitCode !== undefined
      ? `${theme.fg("dim", " · ")}${theme.fg(statusTone(status), `exit ${details.exitCode}`)}`
      : "";
  return `${theme.fg("muted", `$ ${summarizeCommand(details.command)}`)}${exitText}`;
}

export function formatPollPreview(
  content: string,
  details: ParsedMessageDetails | undefined,
  theme: MessageTheme,
): string[] {
  const previewLines = extractPollPreviewLines(content, POLL_MESSAGE_PREVIEW_LINES);
  if (previewLines.length === 0) return [];

  const omittedLineCount = details?.pollOmittedLineCount ?? 0;
  const lineCount = details?.pollLineCount ?? previewLines.length;
  const lines = [""];
  if (omittedLineCount > 0) {
    lines.push(theme.italic(theme.fg("dim", `...${omittedLineCount} earlier lines`)), "");
  }
  lines.push(theme.italic(theme.fg("muted", `Last ${lineCount} lines:`)));
  lines.push(theme.fg("dim", "```log"));
  lines.push(...previewLines.map((line) => theme.fg("muted", line)));
  lines.push(theme.fg("dim", "```"));
  return lines;
}

function formatNotificationNotes(
  details: ParsedMessageDetails | undefined,
  theme: MessageTheme,
): string[] {
  if (details?.outputFile === undefined && details?.windowId === undefined) return [];

  const lines = ["", theme.fg("muted", theme.bold("Notes:"))];
  if (details.outputFile !== undefined) lines.push(theme.fg("dim", `Log: ${details.outputFile}`));
  if (details.windowId !== undefined) {
    lines.push(
      theme.fg(
        "dim",
        `Peek while running: \`tmux capture-pane -t ${details.windowId} -p -S -200\``,
      ),
    );
  }
  if (details.outputFile !== undefined) {
    lines.push(theme.fg("dim", `If closed: \`tail -n 200 ${details.outputFile}\``));
  }
  lines.push(theme.fg("dim", "Run these commands with normal bash tool call."));
  return lines;
}

function extractPollPreviewLines(content: string, lineLimit: number): string[] {
  const fencedMatch = /```(?:\w+)?\n([\s\S]*?)\n```/.exec(content);
  const output = (fencedMatch?.[1] ?? content).trimEnd();
  if (output.length === 0) return [];
  return output.split("\n").slice(-lineLimit);
}

function messageStatusMarker(status: BackgroundShellStatus): string {
  if (status === "failed") return "✗";
  if (status === "completed") return "✓";
  return "◆";
}

function normalizeMessageStatus(
  details: ParsedMessageDetails | undefined,
  kind: MessageKind,
): BackgroundShellStatus {
  if (kind === "poll") return "running";
  if (details?.exitCode !== undefined)
    return String(details.exitCode) === "0" ? "completed" : "failed";
  if (details?.status === "success") return "completed";
  if (details?.status === "failed" || details?.status === "completed") return details.status;
  return "completed";
}

function statusTone(status: BackgroundShellStatus): "success" | "warning" | "error" | "muted" {
  if (status === "running") return "warning";
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  return "muted";
}

function summarizeCommand(command: string): string {
  return command.replaceAll(/\s+/g, " ").trim();
}
