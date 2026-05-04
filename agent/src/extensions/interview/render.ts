import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";

import { createTextComponent, formatToolRail, getTextContent } from "../coreui/tools.js";
import { isNonNullObject } from "./guards.js";
import {
  formatInterviewCountSummary,
  filterAnsweredResponses,
  summarizeInterviewAnswerValue,
} from "./responses.js";
import type { AgentResponseItem, ResponseItem } from "./types.js";

export interface InterviewDetails {
  status: "completed" | "cancelled" | "timeout" | "aborted" | "queued";
  responses: ResponseItem[];
  url: string;
  queuedMessage?: string;
  progressMessage?: string;
  title?: string;
  totalQuestions?: number;
  answeredItems?: AgentResponseItem[];
}

interface InterviewRenderContext {
  isError: boolean;
  isPartial: boolean;
  lastComponent: unknown;
}

type DetailTheme = { fg: (color: "muted" | "dim", text: string) => string };

function toTerminalHyperlink(url: string, label?: string): string {
  return `\u001B]8;;${url}\u0007${label ?? url}\u001B]8;;\u0007`;
}

export function getInterviewLinkLines(url: string, theme: Theme): string[] {
  return [
    theme.fg("accent", url),
    theme.fg("dim", toTerminalHyperlink(url, theme.underline("open"))),
  ];
}

function getInterviewStatus(details: InterviewDetails): {
  label: string;
  color: "success" | "warning" | "error";
} {
  switch (details.status) {
    case "completed": {
      return { label: "interviewed", color: "success" };
    }
    case "cancelled": {
      return { label: "cancelled", color: "error" };
    }
    case "timeout": {
      return { label: "timed out", color: "warning" };
    }
    case "queued": {
      return { label: "queued", color: "warning" };
    }
    case "aborted": {
      return { label: "aborted", color: "error" };
    }
  }

  throw new Error(`Unknown interview status: ${String(details.status)}`);
}

function isInterviewDetails(value: unknown): value is InterviewDetails {
  return (
    isNonNullObject(value) &&
    typeof value.status === "string" &&
    Array.isArray(value.responses) &&
    typeof value.url === "string"
  );
}

function formatInterviewExpandedDetails(
  details: InterviewDetails,
  theme: DetailTheme,
  rail: string,
): string {
  const answeredItems = details.answeredItems ?? [];
  if (answeredItems.length === 0) {
    return `${rail}${theme.fg("dim", "No answers yet")}`;
  }

  return answeredItems
    .map((item) => {
      const value = summarizeInterviewAnswerValue(item.value);
      const attachmentCount = item.attachments?.length ?? 0;
      const attachments =
        attachmentCount > 0
          ? ` ${theme.fg("dim", `[${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}]`)}`
          : "";
      return `${rail}${theme.fg("muted", item.question)}\n${rail}${theme.fg("dim", value)}${attachments}`;
    })
    .join("\n");
}

export function renderInterviewResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: InterviewRenderContext,
): ReturnType<typeof createTextComponent> {
  const details = result.details;
  const rail = formatToolRail(theme, context);
  if (!isInterviewDetails(details)) {
    const status = context.isError
      ? getInterviewStatus({ status: "aborted", responses: [], url: "" })
      : { label: "interviewing", color: "dim" as const };
    return createTextComponent(
      context.lastComponent,
      `${rail}${theme.bold(theme.fg(status.color, status.label))} ${theme.fg("muted", "interview")}`,
    );
  }

  const title = details.title ?? "interview";
  const totalQuestions = details.totalQuestions ?? details.responses.length;
  const answeredCount =
    details.answeredItems?.length ?? filterAnsweredResponses(details.responses).length;

  if (details.status === "queued") {
    const progressText =
      details.progressMessage !== undefined && details.progressMessage.length > 0
        ? details.progressMessage
        : "waiting for browser";
    const header = `${rail}${theme.bold(theme.fg(context.isError ? "error" : "dim", "interviewing"))} ${theme.fg("muted", title)} ${theme.fg("dim", "·")} ${theme.fg("muted", `${answeredCount}/${totalQuestions} answered`)} ${theme.fg("dim", "·")} ${theme.fg("dim", toTerminalHyperlink(details.url, theme.underline("open")))}`;
    if (!options.expanded) {
      return createTextComponent(context.lastComponent, header);
    }

    const message = details.queuedMessage ?? getTextContent(result);
    const lines = [...message.split("\n"), ...getInterviewLinkLines(details.url, theme)]
      .map((line) => `${rail}${theme.fg("dim", line)}`)
      .join("\n");
    return createTextComponent(
      context.lastComponent,
      `${header}\n${rail}${theme.fg("dim", progressText)}\n${formatInterviewExpandedDetails(details, theme, rail)}\n${lines}`,
    );
  }

  const status = getInterviewStatus(details);
  const summary = formatInterviewCountSummary(answeredCount, totalQuestions);
  const header = `${rail}${theme.bold(theme.fg(status.color, status.label))} ${theme.fg("muted", title)} ${theme.fg("dim", "·")} ${theme.fg("muted", summary)}`;
  if (!options.expanded) {
    return createTextComponent(context.lastComponent, header);
  }

  return createTextComponent(
    context.lastComponent,
    `${header}\n${formatInterviewExpandedDetails(details, theme, rail)}`,
  );
}
