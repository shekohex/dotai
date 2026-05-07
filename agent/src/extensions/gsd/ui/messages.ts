import type { Component } from "@mariozechner/pi-tui";
import { Box, Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI, MessageRenderer } from "@mariozechner/pi-coding-agent";

export const GSD_CODEBASE_MAP_SUMMARY_MESSAGE = "gsd-codebase-map-summary";
export const GSD_INTEL_REFRESH_SUMMARY_MESSAGE = "gsd-intel-refresh-summary";

export type GsdCodebaseMapAreaSummary = {
  focus: "tech" | "arch" | "quality" | "concerns";
  documents: string[];
  summary?: string;
  capturedOutput?: string;
  sessionId: string;
};

export type GsdCodebaseMapSummaryDetails = {
  codebaseDir: string;
  areas: GsdCodebaseMapAreaSummary[];
};

export type GsdIntelRefreshSummaryDetails = {
  intelDir: string;
  sessionId: string;
};

function createMessageBox(lines: string[], theme: Parameters<MessageRenderer>[2]): Component {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

function summarizeCapturedOutput(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }

  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  return lines.slice(-3).join(" | ");
}

function createCodebaseMapSummaryRenderer(): MessageRenderer<GsdCodebaseMapSummaryDetails> {
  return (message, { expanded }, theme) => {
    const details = message.details;
    const content = typeof message.content === "string" ? message.content : "";
    const lines = [theme.fg("accent", theme.bold("GSD Codebase Map")), content];

    if (details) {
      lines.push("");
      lines.push(theme.fg("dim", `dir: ${details.codebaseDir}`));
      for (const area of details.areas) {
        const base = `${theme.fg("customMessageLabel", `[${area.focus}]`)} ${area.documents.join(", ")}`;
        lines.push(base);
        const detailText = area.summary ?? summarizeCapturedOutput(area.capturedOutput);
        if (expanded && detailText !== undefined && detailText.length > 0) {
          lines.push(theme.fg("customMessageText", `  ${detailText}`));
        }
      }
    }

    return createMessageBox(lines, theme);
  };
}

function createIntelRefreshSummaryRenderer(): MessageRenderer<GsdIntelRefreshSummaryDetails> {
  return (message, _state, theme) => {
    const details = message.details;
    const content = typeof message.content === "string" ? message.content : "";
    const lines = [theme.fg("accent", theme.bold("GSD Intel Refresh")), content];

    if (details) {
      lines.push("");
      lines.push(theme.fg("dim", `dir: ${details.intelDir}`));
      lines.push(theme.fg("dim", `session: ${details.sessionId}`));
    }

    return createMessageBox(lines, theme);
  };
}

export function registerGsdMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(GSD_CODEBASE_MAP_SUMMARY_MESSAGE, createCodebaseMapSummaryRenderer());
  pi.registerMessageRenderer(
    GSD_INTEL_REFRESH_SUMMARY_MESSAGE,
    createIntelRefreshSummaryRenderer(),
  );
}
