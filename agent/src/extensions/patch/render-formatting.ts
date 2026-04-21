import type { Theme } from "@mariozechner/pi-coding-agent";
import { formatMutedDirSuffix, getToolPathDisplay } from "../coreui/tools.js";
import type { ApplyPatchDetails, PatchTargetDetails } from "./types.js";

export function renderStreamingPatchPreview(
  renderedText: string,
  theme: Theme,
  options: { expanded: boolean; footer?: string; tailLines?: number },
): string {
  const lines = renderedText.split("\n").filter((line) => line.length > 0);
  const tailSize = options.tailLines ?? 5;

  if (options.expanded) {
    const footerLine =
      options.footer !== undefined && options.footer.length > 0
        ? `${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}`
        : "";
    return [renderedText, footerLine].filter(Boolean).join("\n");
  }

  const visibleLines = lines.slice(-tailSize);
  const earlierCount = Math.max(lines.length - visibleLines.length, 0);
  const blocks: string[] = [];

  if (earlierCount > 0) {
    blocks.push(
      `${theme.fg("dim", "↳ ")}${theme.fg("muted", `... (${earlierCount} earlier lines)`)}`,
    );
  }

  if (visibleLines.length > 0) {
    blocks.push(visibleLines.join("\n"));
  }

  if (options.footer !== undefined && options.footer.length > 0) {
    blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}`);
  }

  return blocks.join("\n");
}

export function formatSinglePatchHeadline(
  details: ApplyPatchDetails,
  theme: Theme,
  cwd: string,
): string {
  if (details.files.length !== 1) {
    return "";
  }

  const [file] = details.files;
  const targetPath = file.movePath ?? file.filePath;
  const pathDisplay = getToolPathDisplay(targetPath, cwd);
  return `${theme.fg("text", pathDisplay.basename)}${formatMutedDirSuffix(theme, pathDisplay.dirSuffix)}`;
}

export function formatPatchRail(
  theme: Theme,
  context: { isPartial?: boolean; isError?: boolean },
): string {
  if (context.isError === true) {
    return theme.fg("error", "▏");
  }

  if (context.isPartial === true) {
    return theme.fg("borderAccent", "▏");
  }

  return theme.fg("borderMuted", "▏");
}

export function formatPatchHeadline(details: ApplyPatchDetails, partial: boolean): string {
  if (details.targets.length === 0) {
    return "...";
  }

  if (details.targets.length === 1) {
    return formatPatchTargetLabel(details.targets[0], partial);
  }

  return `${details.totalFiles} files`;
}

export function formatPatchTargetList(
  targets: PatchTargetDetails[],
  _theme: Theme,
  expanded: boolean,
  options: { prefix?: string } = {},
): string {
  const visibleTargets = expanded ? targets : targets.slice(0, 3);
  const list = visibleTargets.map((target) => formatPatchTargetLabel(target, true)).join(", ");
  const remaining = targets.length - visibleTargets.length;
  const parts = [options.prefix, list || undefined];

  if (remaining > 0) {
    parts.push(`+${remaining} more`);
  }

  return parts.filter(Boolean).join(" · ");
}

function formatPatchTargetLabel(target: PatchTargetDetails, partial: boolean): string {
  if (
    !partial &&
    target.type === "move" &&
    target.sourcePath !== undefined &&
    target.sourcePath.length > 0
  ) {
    return `${target.sourcePath} → ${target.relativePath}`;
  }

  return target.relativePath;
}

export function stylePatchInputPreview(patchText: string, theme: Theme): string {
  return patchText
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      if (line.startsWith("***")) {
        return theme.fg("muted", line);
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
    })
    .join("\n");
}
