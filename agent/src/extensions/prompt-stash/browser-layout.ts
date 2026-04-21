import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Container, Input, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { countLines, formatPreview, formatRelativeAge } from "./browser-helpers.js";

type PromptStashEntry = {
  id: string;
  text: string;
  createdAt: number;
};

export function initializePromptStashBrowserRoot(input: {
  root: Container;
  theme: Theme;
  searchInput: Input;
  listContainer: Container;
  previewContainer: Container;
}): void {
  const { root, theme, searchInput, listContainer, previewContainer } = input;
  root.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
  root.addChild(new Text(theme.fg("accent", theme.bold(" Prompt Stash ")), 0, 0));
  root.addChild(new Spacer(1));
  root.addChild(
    new Text(
      theme.fg(
        "dim",
        "Search to filter • enter open • ctrl+alt+o pop • ctrl+backspace delete • esc cancel",
      ),
      0,
      0,
    ),
  );
  root.addChild(new Spacer(1));
  root.addChild(new Text(theme.fg("muted", "Search"), 0, 0));
  root.addChild(searchInput);
  root.addChild(new Spacer(1));
  root.addChild(listContainer);
  root.addChild(new Spacer(1));
  root.addChild(previewContainer);
  root.addChild(new Spacer(1));
  root.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
}

export function getEmptyListMessage(totalEntries: number): string {
  return totalEntries === 0 ? "No stashed prompts yet" : "No matching stash entries";
}

export function getPreviewHint(totalEntries: number): string {
  return totalEntries === 0
    ? "Press ctrl+alt+s to stash the current prompt"
    : "Choose a stash entry to preview it here";
}

export function formatPreviewMeta(entry: PromptStashEntry, maxWidth: number): string {
  return ` ${countLines(entry.text)} lines • ${formatRelativeAge(entry.createdAt)} • ${truncateToWidth(formatPreview(entry.text), maxWidth, "")}`;
}
