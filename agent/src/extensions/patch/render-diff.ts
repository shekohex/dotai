import { createTwoFilesPatch } from "diff";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { trimDiff } from "./content.js";
import type { PatchFileDetails } from "./types.js";

export function countPatchChanges(files: PatchFileDetails[]): {
  additions: number;
  deletions: number;
} {
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function formatPatchChangeSummary(
  theme: Theme,
  additions: number,
  deletions: number,
): string {
  return `${theme.fg("toolDiffAdded", `+${additions}`)} ${theme.fg("toolDiffRemoved", `-${deletions}`)}`;
}

export function formatExpandedPatchFileLabel(file: PatchFileDetails, theme: Theme): string {
  if (file.type === "add") {
    return theme.fg("muted", `A ${file.relativePath}`);
  }

  if (file.type === "delete") {
    return theme.fg("muted", `D ${file.relativePath}`);
  }

  if (file.type === "move") {
    return theme.fg(
      "muted",
      `R ${file.sourceRelativePath ?? file.relativePath} → ${file.relativePath}`,
    );
  }

  return `${theme.fg("muted", `M ${file.relativePath} · `)}${formatPatchChangeSummary(theme, file.additions, file.deletions)}`;
}

export function renderPatchFileDiff(file: PatchFileDetails, theme: Theme): string {
  return renderGitStyleDiff(file, theme);
}

function renderGitStyleDiff(file: PatchFileDetails, theme: Theme): string {
  const sourcePath =
    file.type === "add" ? "/dev/null" : `a/${file.sourceRelativePath ?? file.relativePath}`;
  const targetPath = file.type === "delete" ? "/dev/null" : `b/${file.relativePath}`;
  const diff = trimDiff(createTwoFilesPatch(sourcePath, targetPath, file.before, file.after));
  const relativeSourcePath = file.sourceRelativePath ?? file.relativePath;
  const relativeTargetPath = file.relativePath;
  const headerLines = [
    theme.fg("muted", `diff --git a/${relativeSourcePath} b/${relativeTargetPath}`),
  ];

  if (file.type === "move") {
    headerLines.push(theme.fg("muted", `rename from ${relativeSourcePath}`));
    headerLines.push(theme.fg("muted", `rename to ${relativeTargetPath}`));
  }

  for (const line of diff.split("\n")) {
    const formatted = formatGitStyleDiffLine(line, theme);
    if (formatted !== undefined) {
      headerLines.push(formatted);
    }
  }

  return headerLines.join("\n");
}

function formatGitStyleDiffLine(line: string, theme: Theme): string | undefined {
  if (!line) {
    return "";
  }
  if (
    line.startsWith("Index:") ||
    line.startsWith("===================================================================")
  ) {
    return undefined;
  }
  if (line.startsWith("--- ")) {
    return theme.fg("muted", `--- ${line.slice(4)}`);
  }
  if (line.startsWith("+++ ")) {
    return theme.fg("muted", `+++ ${line.slice(4)}`);
  }
  if (line.startsWith("@@")) {
    return theme.fg("accent", line);
  }
  if (line.startsWith("+")) {
    return theme.fg("toolDiffAdded", line);
  }
  if (line.startsWith("-")) {
    return theme.fg("toolDiffRemoved", line);
  }

  return theme.fg("toolDiffContext", line);
}
