import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, type SelectItem, type SelectListTheme } from "@mariozechner/pi-tui";

type PromptStashEntry = {
  id: string;
  text: string;
  createdAt: number;
};

export function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
}

export function formatRelativeAge(createdAt: number): string {
  const elapsedMs = Math.max(0, Date.now() - createdAt);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) {
    return "just now";
  }
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }
  return `${Math.floor(elapsedHours / 24)}d ago`;
}

export function formatPreview(text: string): string {
  const trimmed = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return trimmed === undefined ? "(empty)" : truncateToWidth(trimmed, 96, "…");
}

export function createSelectItem(entry: PromptStashEntry): SelectItem {
  return {
    value: entry.id,
    label: formatPreview(entry.text),
    description: `${countLines(entry.text)} lines • ${formatRelativeAge(entry.createdAt)}`,
  };
}

export function createSelectListTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  };
}

export function formatPreviewLines(entry: PromptStashEntry, width: number): string[] {
  const lines = entry.text.split(/\r\n|\r|\n/).slice(0, 4);
  const previewLines = lines.map((line) => truncateToWidth(line, Math.max(0, width), ""));
  const remaining = countLines(entry.text) - lines.length;
  if (remaining > 0) {
    previewLines.push(truncateToWidth(`… ${remaining} more`, Math.max(0, width), ""));
  }
  return previewLines;
}
