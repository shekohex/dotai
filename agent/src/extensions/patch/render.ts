import * as path from "node:path";
import type {
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { createTextComponent } from "../coreui/tools.js";
import { summarizePartialPatchText } from "./parser.js";
import { getApplyPatchDetails } from "./render-details.js";
import {
  formatPatchHeadline,
  formatPatchRail,
  formatPatchTargetList,
  formatSinglePatchHeadline,
  renderStreamingPatchPreview,
  stylePatchInputPreview,
} from "./render-formatting.js";
import {
  countPatchChanges,
  formatExpandedPatchFileLabel,
  formatPatchChangeSummary,
  renderPatchFileDiff,
} from "./render-diff.js";
import type {
  ApplyPatchDetails,
  ApplyPatchRenderState,
  PatchFileChange,
  PatchFileDetails,
  PatchTargetDetails,
} from "./types.js";

export type PatchCallRenderContext = {
  isPartial: boolean;
  argsComplete: boolean;
  expanded: boolean;
  isError: boolean;
  cwd: string;
  state: ApplyPatchRenderState;
};

export type PatchRenderSyncContext = {
  state: ApplyPatchRenderState;
  invalidate: () => void;
};

export function formatApplyPatchCall(
  patchText: string,
  theme: Theme,
  context: PatchCallRenderContext,
): string {
  const rail = formatPatchRail(theme, context);
  if (context.isPartial && !context.argsComplete && patchText.trim().length > 0) {
    const streamedTargets = summarizePartialPatchText(patchText);
    const headline =
      streamedTargets.length > 1
        ? `${streamedTargets.length} files`
        : (streamedTargets[0]?.relativePath ?? "...");
    const preview = renderStreamingPatchPreview(stylePatchInputPreview(patchText, theme), theme, {
      expanded: context.expanded,
      footer:
        streamedTargets.length > 0
          ? formatPatchTargetList(streamedTargets, theme, context.expanded)
          : undefined,
      tailLines: 6,
    });
    return [
      `${rail}${theme.italic(theme.fg("muted", "patching"))} ${theme.fg("muted", headline)}`,
      preview,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const details = getApplyPatchDetails(context.state.applyPatchDetails, patchText);
  const progress =
    context.isPartial && details.totalFiles > 1
      ? theme.fg("muted", ` · ${details.completedFiles}/${details.totalFiles}`)
      : "";

  if (context.isError) {
    return `${rail}${theme.bold(theme.fg("error", "patch"))} ${theme.fg("muted", formatPatchHeadline(details, false))}`;
  }

  if (context.isPartial) {
    return `${rail}${theme.italic(theme.fg("muted", "patching"))} ${theme.fg("muted", formatPatchHeadline(details, true))}${progress}`;
  }

  return formatApplyPatchSuccess(details, theme, context.cwd, context);
}

export function formatApplyPatchSuccess(
  details: ApplyPatchDetails,
  theme: Theme,
  cwd: string,
  context?: { isPartial?: boolean; isError?: boolean },
): string {
  const rail = formatPatchRail(theme, context ?? { isPartial: false, isError: false });
  const totalChanges = countPatchChanges(details.files);
  const totalSummary =
    totalChanges.additions + totalChanges.deletions > 0
      ? `${theme.fg("muted", " · ")}${formatPatchChangeSummary(theme, totalChanges.additions, totalChanges.deletions)}`
      : "";
  const singleFileHeadline = formatSinglePatchHeadline(details, theme, cwd);
  if (singleFileHeadline) {
    return `${rail}${theme.bold(theme.fg("muted", "patched"))} ${singleFileHeadline}${totalSummary}`;
  }

  return `${rail}${theme.bold(theme.fg("muted", "patched"))} ${theme.fg("muted", formatPatchHeadline(details, false))}${totalSummary}`;
}

export function renderApplyPatchProgress(
  details: ApplyPatchDetails,
  theme: Theme,
  expanded: boolean,
): string {
  const diffText = details.files
    .map((file) => renderPatchFileDiff(file, theme))
    .join("\n\n")
    .trim();

  if (diffText) {
    return renderStreamingPatchPreview(diffText, theme, {
      expanded,
      footer: `${details.completedFiles}/${Math.max(details.totalFiles, 1)} files`,
    });
  }

  if (details.totalFiles <= 1) {
    return theme.fg("dim", `↳ ${details.completedFiles}/${Math.max(details.totalFiles, 1)} files`);
  }

  const list = formatPatchTargetList(details.targets, theme, expanded, {
    prefix: `${details.completedFiles}/${details.totalFiles}`,
  });

  if (!expanded) {
    return theme.fg("dim", `↳ ${list}`);
  }

  return list;
}

export function renderApplyPatchCollapsedSuccess(
  _details: ApplyPatchDetails,
  _theme: Theme,
): string {
  return "";
}

export function renderApplyPatchExpandedSuccess(
  details: ApplyPatchDetails,
  theme: Theme,
  _patchText: string,
): string {
  if (details.files.length === 0) {
    return "";
  }

  const rendered = details.files
    .map(
      (file) => `${formatExpandedPatchFileLabel(file, theme)}\n${renderPatchFileDiff(file, theme)}`,
    )
    .join("\n\n");

  return rendered;
}

export function renderApplyPatchError(
  targets: PatchTargetDetails[],
  output: string,
  theme: Theme,
  expanded: boolean,
): string {
  const lines: string[] = [];
  if (targets.length > 1) {
    const list = formatPatchTargetList(targets, theme, expanded);
    lines.push(theme.fg("dim", `↳ ${list}`));
  }

  if (output) {
    lines.push(theme.fg("error", `↳ ${output}`));
  }

  return lines.join("\n");
}

export function createPatchFileDetailsFromChanges(
  changes: PatchFileChange[],
  ctx: ExtensionContext,
): PatchFileDetails[] {
  return changes.map(
    (change) =>
      ({
        filePath: change.filePath,
        relativePath: path
          .relative(ctx.cwd, change.movePath ?? change.filePath)
          .replaceAll("\\", "/"),
        sourceRelativePath:
          change.type === "move"
            ? path.relative(ctx.cwd, change.filePath).replaceAll("\\", "/")
            : undefined,
        type: change.type,
        diff: change.diff,
        before: change.oldContent,
        after: change.newContent,
        additions: change.additions,
        deletions: change.deletions,
        movePath: change.movePath,
      }) satisfies PatchFileDetails,
  );
}

export function emitApplyPatchUpdate(
  onUpdate: AgentToolUpdateCallback<ApplyPatchDetails> | undefined,
  details: ApplyPatchDetails,
): void {
  if (!onUpdate) {
    return;
  }

  onUpdate({
    content: [
      { type: "text", text: `Patching ${details.completedFiles}/${details.totalFiles} files` },
    ],
    details,
  });
}

export function syncPatchRenderState(
  context: PatchRenderSyncContext,
  details: ApplyPatchDetails | undefined,
  output: string,
): void {
  const fileCount = Array.isArray(details?.files) ? details.files.length : 0;
  const diffLength = typeof details?.diff === "string" ? details.diff.length : 0;
  const completedFiles = typeof details?.completedFiles === "number" ? details.completedFiles : 0;
  const totalFiles = typeof details?.totalFiles === "number" ? details.totalFiles : 0;
  const nextSignature = details
    ? `${completedFiles}/${totalFiles}:${fileCount}:${diffLength}:${output}`
    : `error:${output}`;

  if (context.state.applyPatchSignature === nextSignature) {
    return;
  }

  context.state.applyPatchSignature = nextSignature;
  context.state.applyPatchDetails = details;
  queueMicrotask(() => {
    context.invalidate();
  });
}

export function setPatchCallComponent(
  state: ApplyPatchRenderState,
  lastComponent: unknown,
  text: string,
) {
  const component = createTextComponent(state.callComponent ?? lastComponent, text);
  state.callComponent = component;
  state.callText = text;
  return component;
}

export function applyCollapsedPatchSummaryToCall(state: ApplyPatchRenderState, text: string): void {
  if (
    state.callText === undefined ||
    state.callText.length === 0 ||
    state.callComponent === undefined
  ) {
    return;
  }

  createTextComponent(state.callComponent, text);
  state.callText = text;
}

export function getResultText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
}
