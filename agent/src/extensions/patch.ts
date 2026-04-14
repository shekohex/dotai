import { createTwoFilesPatch, diffLines } from "diff";
import {
  defineTool,
  isToolCallEventType,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createTextComponent, formatMutedDirSuffix, getToolPathDisplay } from "./coreui/tools.js";

type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; move_path?: string; chunks: UpdateFileChunk[] };

type UpdateFileChunk = {
  old_lines: string[];
  new_lines: string[];
  change_context?: string;
  is_end_of_file?: boolean;
};

type PatchFileChange = {
  filePath: string;
  oldContent: string;
  newContent: string;
  type: "add" | "update" | "delete" | "move";
  movePath?: string;
  diff: string;
  additions: number;
  deletions: number;
};

type PatchFileDetails = {
  filePath: string;
  relativePath: string;
  sourceRelativePath?: string;
  type: "add" | "update" | "delete" | "move";
  diff: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  movePath?: string;
};

type PatchTargetDetails = {
  relativePath: string;
  type: "add" | "update" | "delete" | "move";
  sourcePath?: string;
};

type ApplyPatchDetails = {
  diff: string;
  files: PatchFileDetails[];
  targets: PatchTargetDetails[];
  totalFiles: number;
  completedFiles: number;
};

type ApplyPatchRenderState = {
  applyPatchDetails?: ApplyPatchDetails;
  applyPatchSignature?: string;
  callComponent?: unknown;
  callText?: string;
};

const APPLY_PATCH_DESCRIPTION = `Use the \`apply_patch\` tool to edit files. Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Example patch:

\`\`\`
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
\`\`\`

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file
`;

export const applyPatchTool = defineTool({
  name: "apply_patch",
  label: "patch",
  description: APPLY_PATCH_DESCRIPTION,
  promptSnippet: `use \`apply_patch\` to edit/patch files`,
  parameters: Type.Object(
    {
      patchText: Type.String({
        description: "The full patch text that describes all changes to be made",
      }),
    },
    { additionalProperties: false },
  ),
  async execute(_toolCallId, params, _signal, onUpdate, ctx) {
    if (!params.patchText) {
      throw new Error("patchText is required");
    }

    let hunks: Hunk[];
    try {
      hunks = parsePatch(params.patchText).hunks;
    } catch (error) {
      throw new Error(`apply_patch verification failed: ${error}`);
    }

    if (hunks.length === 0) {
      const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
      if (normalized === "*** Begin Patch\n*** End Patch") {
        throw new Error("patch rejected: empty patch");
      }
      throw new Error("apply_patch verification failed: no hunks found");
    }

    const queuePaths = getQueuePaths(hunks, ctx);
    const targets = summarizeHunks(hunks);

    return withFileMutationQueues(queuePaths, async () => {
      const fileChanges: PatchFileChange[] = [];
      let totalDiff = "";

      emitApplyPatchUpdate(onUpdate, {
        diff: totalDiff,
        files: [],
        targets,
        totalFiles: targets.length,
        completedFiles: 0,
      });

      for (const hunk of hunks) {
        const filePath = resolvePatchPath(ctx, hunk.path);

        switch (hunk.type) {
          case "add": {
            const oldContent = "";
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n")
                ? hunk.contents
                : `${hunk.contents}\n`;
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent));

            let additions = 0;
            let deletions = 0;
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0;
              if (change.removed) deletions += change.count || 0;
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: "add",
              diff,
              additions,
              deletions,
            });

            totalDiff += `${diff}\n`;
            emitApplyPatchUpdate(onUpdate, {
              diff: totalDiff,
              files: createPatchFileDetailsFromChanges(fileChanges, ctx),
              targets,
              totalFiles: targets.length,
              completedFiles: fileChanges.length,
            });
            break;
          }

          case "update": {
            const stats = await fs.stat(filePath).catch(() => null);
            if (!stats || stats.isDirectory()) {
              throw new Error(
                `apply_patch verification failed: Failed to read file to update: ${filePath}`,
              );
            }

            const oldContent = await fs.readFile(filePath, "utf-8");
            let newContent = oldContent;

            try {
              const fileUpdate = deriveNewContentsFromChunks(filePath, hunk.chunks);
              newContent = fileUpdate.content;
            } catch (error) {
              throw new Error(`apply_patch verification failed: ${error}`);
            }

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent));

            let additions = 0;
            let deletions = 0;
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0;
              if (change.removed) deletions += change.count || 0;
            }

            const movePath = hunk.move_path ? resolvePatchPath(ctx, hunk.move_path) : undefined;

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
            });

            totalDiff += `${diff}\n`;
            emitApplyPatchUpdate(onUpdate, {
              diff: totalDiff,
              files: createPatchFileDetailsFromChanges(fileChanges, ctx),
              targets,
              totalFiles: targets.length,
              completedFiles: fileChanges.length,
            });
            break;
          }

          case "delete": {
            const contentToDelete = await fs.readFile(filePath, "utf-8").catch((error) => {
              throw new Error(`apply_patch verification failed: ${error}`);
            });
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""));
            const deletions = contentToDelete.split("\n").length;

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff,
              additions: 0,
              deletions,
            });

            totalDiff += `${diff}\n`;
            emitApplyPatchUpdate(onUpdate, {
              diff: totalDiff,
              files: createPatchFileDetailsFromChanges(fileChanges, ctx),
              targets,
              totalFiles: targets.length,
              completedFiles: fileChanges.length,
            });
            break;
          }
        }
      }

      const files = createPatchFileDetailsFromChanges(fileChanges, ctx);

      for (const change of fileChanges) {
        switch (change.type) {
          case "add":
            await fs.mkdir(path.dirname(change.filePath), { recursive: true });
            await fs.writeFile(change.filePath, change.newContent, "utf-8");
            break;
          case "update":
            await fs.writeFile(change.filePath, change.newContent, "utf-8");
            break;
          case "move":
            if (change.movePath) {
              await fs.mkdir(path.dirname(change.movePath), { recursive: true });
              await fs.writeFile(change.movePath, change.newContent, "utf-8");
              await fs.unlink(change.filePath);
            }
            break;
          case "delete":
            await fs.unlink(change.filePath);
            break;
        }
      }

      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(ctx.cwd, change.filePath).replaceAll("\\", "/")}`;
        }
        if (change.type === "delete") {
          return `D ${path.relative(ctx.cwd, change.filePath).replaceAll("\\", "/")}`;
        }
        const target = change.movePath ?? change.filePath;
        return `M ${path.relative(ctx.cwd, target).replaceAll("\\", "/")}`;
      });

      const output = `Success. Updated the following files:\n${summaryLines.join("\n")}`;

      return {
        content: [{ type: "text", text: output }],
        details: {
          diff: totalDiff,
          files,
          targets,
          totalFiles: targets.length,
          completedFiles: files.length,
        } satisfies ApplyPatchDetails,
      };
    });
  },
  renderCall(args, theme, context) {
    return setPatchCallComponent(
      context.state as ApplyPatchRenderState,
      context.lastComponent,
      formatApplyPatchCall(args.patchText, theme, context),
    );
  },
  renderResult(result, options, theme, context) {
    syncPatchRenderState(
      context,
      result.details as ApplyPatchDetails | undefined,
      getResultText(result.content),
    );
    const output = getResultText(result.content);
    const details = getApplyPatchDetails(result.details, context.args.patchText);
    const state = context.state as ApplyPatchRenderState;

    if (context.isError) {
      if (options.expanded) {
        return createTextComponent(
          context.lastComponent,
          renderApplyPatchError(details.targets, output, theme, true),
        );
      }
      return createTextComponent(context.lastComponent, "");
    }

    if (options.isPartial) {
      return createTextComponent(
        context.lastComponent,
        renderApplyPatchProgress(details, theme, options.expanded),
      );
    }

    if (!options.expanded) {
      applyCollapsedPatchSummaryToCall(state, formatApplyPatchSuccess(details, theme, context.cwd));
      return createTextComponent(
        context.lastComponent,
        renderApplyPatchCollapsedSuccess(details, theme),
      );
    }

    return createTextComponent(
      context.lastComponent,
      renderApplyPatchExpandedSuccess(details, theme, context.args.patchText),
    );
  },
});

export default function patchExtension(pi: ExtensionAPI) {
  pi.registerTool(applyPatchTool);

  let patchMode = false;
  let savedToolsBeforePatch: string[] | undefined;

  const syncTools = (ctx: ExtensionContext) => {
    const modelId = ctx.model?.id;
    const shouldEnablePatch = shouldUsePatch(modelId);
    const activeTools = pi.getActiveTools();

    if (shouldEnablePatch) {
      if (!patchMode) {
        savedToolsBeforePatch = activeTools.filter((toolName) => toolName !== "apply_patch");
      }

      const nextTools = new Set(activeTools);
      nextTools.delete("edit");
      nextTools.delete("write");
      nextTools.add(applyPatchTool.name);
      const next = Array.from(nextTools);
      if (!sameToolSet(activeTools, next)) {
        pi.setActiveTools(next);
      }
      patchMode = true;
      return;
    }

    if (patchMode) {
      const restored = (
        savedToolsBeforePatch ?? activeTools.filter((toolName) => toolName !== "apply_patch")
      ).filter((toolName) => toolName !== "apply_patch");
      if (!sameToolSet(activeTools, restored)) {
        pi.setActiveTools(restored);
      }
      savedToolsBeforePatch = undefined;
      patchMode = false;
      return;
    }

    if (activeTools.includes("apply_patch")) {
      const next = activeTools.filter((toolName) => toolName !== "apply_patch");
      if (!sameToolSet(activeTools, next)) {
        pi.setActiveTools(next);
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    syncTools(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    syncTools(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    syncTools(ctx);
    return undefined;
  });

  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) {
      return undefined;
    }

    const command = event.input.command.trim();
    if (pi.getActiveTools().includes(applyPatchTool.name)) {
      return undefined;
    }

    if (!isApplyPatchShellCommand(command)) {
      return undefined;
    }

    return {
      block: true,
      reason:
        "`apply_patch` is not active for this model. Use the available file-editing tools instead.",
    };
  });
}

export function shouldUsePatch(modelId: string | undefined): boolean {
  if (!modelId) {
    return false;
  }

  const normalizedModelId = modelId.toLowerCase();
  return (
    normalizedModelId.includes("gpt-") &&
    !normalizedModelId.includes("oss") &&
    !normalizedModelId.includes("gpt-4")
  );
}

function sameToolSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }

  return true;
}

function isApplyPatchShellCommand(command: string): boolean {
  return /(^|[\n;&|]\s*)(?:apply_patch|applypatch)\b/.test(command);
}

function resolvePatchPath(ctx: ExtensionContext, filePath: string): string {
  const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  return path.resolve(ctx.cwd, normalized);
}

function getQueuePaths(hunks: Hunk[], ctx: ExtensionContext): string[] {
  const unique = new Set<string>();
  for (const hunk of hunks) {
    unique.add(resolvePatchPath(ctx, hunk.path));
    if (hunk.type === "update" && hunk.move_path) {
      unique.add(resolvePatchPath(ctx, hunk.move_path));
    }
  }
  return Array.from(unique).sort();
}

async function withFileMutationQueues<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  if (paths.length === 0) {
    return fn();
  }

  const [first, ...rest] = paths;
  return withFileMutationQueue(first, () => withFileMutationQueues(rest, fn));
}

function formatApplyPatchCall(patchText: string, theme: any, context: any): string {
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
      `${theme.italic(theme.fg("muted", "patching"))} ${theme.fg("muted", headline)}`,
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
    return `${theme.bold(theme.fg("error", "patch"))} ${theme.fg("muted", formatPatchHeadline(details, false))}`;
  }

  if (context.isPartial) {
    return `${theme.italic(theme.fg("muted", "patching"))} ${theme.fg("muted", formatPatchHeadline(details, true))}${progress}`;
  }

  return formatApplyPatchSuccess(details, theme, context.cwd);
}

function formatApplyPatchSuccess(details: ApplyPatchDetails, theme: any, cwd: string): string {
  const totalChanges = countPatchChanges(details.files);
  const totalSummary =
    totalChanges.additions + totalChanges.deletions > 0
      ? `${theme.fg("muted", " · ")}${formatPatchChangeSummary(theme, totalChanges.additions, totalChanges.deletions)}`
      : "";
  const singleFileHeadline = formatSinglePatchHeadline(details, theme, cwd);
  if (singleFileHeadline) {
    return `${theme.bold(theme.fg("muted", "patched"))} ${singleFileHeadline}${totalSummary}`;
  }

  return `${theme.bold(theme.fg("muted", "patched"))} ${theme.fg("muted", formatPatchHeadline(details, false))}${totalSummary}`;
}

function renderApplyPatchProgress(
  details: ApplyPatchDetails,
  theme: any,
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

function renderStreamingPatchPreview(
  renderedText: string,
  theme: any,
  options: { expanded: boolean; footer?: string; tailLines?: number },
): string {
  const lines = renderedText.split("\n").filter((line) => line.length > 0);
  const tailSize = options.tailLines ?? 5;

  if (options.expanded) {
    return [
      renderedText,
      options.footer ? `${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
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

  if (options.footer) {
    blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}`);
  }

  return blocks.join("\n");
}

function renderApplyPatchCollapsedSuccess(_details: ApplyPatchDetails, _theme: any): string {
  return "";
}

function formatSinglePatchHeadline(details: ApplyPatchDetails, theme: any, cwd: string): string {
  if (details.files.length !== 1) {
    return "";
  }

  const [file] = details.files;
  const targetPath = file.movePath ?? file.filePath;
  const pathDisplay = getToolPathDisplay(targetPath, cwd);
  return `${theme.fg("text", pathDisplay.basename)}${formatMutedDirSuffix(theme, pathDisplay.dirSuffix)}`;
}

function renderApplyPatchExpandedSuccess(
  details: ApplyPatchDetails,
  theme: any,
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

function renderApplyPatchError(
  targets: PatchTargetDetails[],
  output: string,
  theme: any,
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

function formatPatchHeadline(details: ApplyPatchDetails, partial: boolean): string {
  if (details.targets.length === 0) {
    return "...";
  }

  if (details.targets.length === 1) {
    return formatPatchTargetLabel(details.targets[0], partial);
  }

  return `${details.totalFiles} files`;
}

function formatPatchTargetList(
  targets: PatchTargetDetails[],
  theme: any,
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
  if (!partial && target.type === "move" && target.sourcePath) {
    return `${target.sourcePath} → ${target.relativePath}`;
  }

  return target.relativePath;
}

function formatExpandedPatchFileLabel(file: PatchFileDetails, theme: any): string {
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

function renderPatchFileDiff(file: PatchFileDetails, theme: any): string {
  return renderGitStyleDiff(file, theme);
}

function renderGitStyleDiff(file: PatchFileDetails, theme: any): string {
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
    if (!line) {
      headerLines.push("");
      continue;
    }

    if (
      line.startsWith("Index:") ||
      line.startsWith("===================================================================")
    ) {
      continue;
    }

    if (line.startsWith("--- ")) {
      headerLines.push(theme.fg("muted", `--- ${line.slice(4)}`));
      continue;
    }

    if (line.startsWith("+++ ")) {
      headerLines.push(theme.fg("muted", `+++ ${line.slice(4)}`));
      continue;
    }

    if (line.startsWith("@@")) {
      headerLines.push(theme.fg("accent", line));
      continue;
    }

    if (line.startsWith("+")) {
      headerLines.push(theme.fg("toolDiffAdded", line));
      continue;
    }

    if (line.startsWith("-")) {
      headerLines.push(theme.fg("toolDiffRemoved", line));
      continue;
    }

    headerLines.push(theme.fg("toolDiffContext", line));
  }

  return headerLines.join("\n");
}

function getApplyPatchDetails(details: unknown, patchText: string): ApplyPatchDetails {
  if (details && typeof details === "object") {
    const patchDetails = details as Partial<ApplyPatchDetails>;
    if (Array.isArray(patchDetails.targets)) {
      return {
        diff: typeof patchDetails.diff === "string" ? patchDetails.diff : "",
        files: Array.isArray(patchDetails.files) ? patchDetails.files : [],
        targets: patchDetails.targets,
        totalFiles:
          typeof patchDetails.totalFiles === "number"
            ? patchDetails.totalFiles
            : patchDetails.targets.length,
        completedFiles:
          typeof patchDetails.completedFiles === "number"
            ? patchDetails.completedFiles
            : Array.isArray(patchDetails.files)
              ? patchDetails.files.length
              : 0,
      };
    }
  }

  const targets = summarizePatchText(patchText);
  return {
    diff: "",
    files: [],
    targets,
    totalFiles: targets.length,
    completedFiles: 0,
  };
}

function summarizePatchText(patchText: string): PatchTargetDetails[] {
  try {
    return summarizeHunks(parsePatch(patchText).hunks);
  } catch {
    return [];
  }
}

function summarizePartialPatchText(patchText: string): PatchTargetDetails[] {
  const targets: PatchTargetDetails[] = [];
  const lines = stripHeredoc(patchText.trim()).split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("*** Add File:")) {
      targets.push({ relativePath: line.slice("*** Add File:".length).trim(), type: "add" });
      continue;
    }
    if (line.startsWith("*** Delete File:")) {
      targets.push({ relativePath: line.slice("*** Delete File:".length).trim(), type: "delete" });
      continue;
    }
    if (line.startsWith("*** Update File:")) {
      const relativePath = line.slice("*** Update File:".length).trim();
      const moveLine = lines[i + 1]?.trim();
      if (moveLine?.startsWith("*** Move to:")) {
        targets.push({
          relativePath: moveLine.slice("*** Move to:".length).trim(),
          type: "move",
          sourcePath: relativePath,
        });
        i++;
        continue;
      }
      targets.push({ relativePath, type: "update" });
    }
  }

  return targets.filter((target) => target.relativePath.length > 0);
}

function stylePatchInputPreview(patchText: string, theme: any): string {
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

function summarizeHunks(hunks: Hunk[]): PatchTargetDetails[] {
  return hunks.map((hunk) => ({
    relativePath: hunk.type === "update" && hunk.move_path ? hunk.move_path : hunk.path,
    type: hunk.type === "update" && hunk.move_path ? "move" : hunk.type,
    sourcePath: hunk.type === "update" && hunk.move_path ? hunk.path : undefined,
  }));
}

function createPatchFileDetailsFromChanges(
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

function countPatchChanges(files: PatchFileDetails[]): { additions: number; deletions: number } {
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

function formatPatchChangeSummary(theme: any, additions: number, deletions: number): string {
  return `${theme.fg("toolDiffAdded", `+${additions}`)} ${theme.fg("toolDiffRemoved", `-${deletions}`)}`;
}

function emitApplyPatchUpdate(
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

function syncPatchRenderState(
  context: any,
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

function setPatchCallComponent(state: ApplyPatchRenderState, lastComponent: unknown, text: string) {
  const component = createTextComponent(state.callComponent ?? lastComponent, text);
  state.callComponent = component;
  state.callText = text;
  return component;
}

function applyCollapsedPatchSummaryToCall(state: ApplyPatchRenderState, text: string): void {
  if (!state.callText || !state.callComponent) {
    return;
  }

  createTextComponent(state.callComponent, text);
  state.callText = text;
}

function getResultText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
}

function parsePatchHeader(
  lines: string[],
  startIdx: number,
): { filePath: string; movePath?: string; nextIdx: number } | null {
  const line = lines[startIdx];

  if (line.startsWith("*** Add File:")) {
    const filePath = line.slice("*** Add File:".length).trim();
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
  }

  if (line.startsWith("*** Delete File:")) {
    const filePath = line.slice("*** Delete File:".length).trim();
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
  }

  if (line.startsWith("*** Update File:")) {
    const filePath = line.slice("*** Update File:".length).trim();
    let movePath: string | undefined;
    let nextIdx = startIdx + 1;

    if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
      movePath = lines[nextIdx].slice("*** Move to:".length).trim();
      nextIdx++;
    }

    return filePath ? { filePath, movePath, nextIdx } : null;
  }

  return null;
}

function parseUpdateFileChunks(
  lines: string[],
  startIdx: number,
): { chunks: UpdateFileChunk[]; nextIdx: number } {
  const chunks: UpdateFileChunk[] = [];
  let i = startIdx;

  while (i < lines.length && !lines[i].startsWith("***")) {
    if (lines[i].startsWith("@@")) {
      const contextLine = lines[i].substring(2).trim();
      i++;

      const oldLines: string[] = [];
      const newLines: string[] = [];
      let isEndOfFile = false;

      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
        const changeLine = lines[i];

        if (changeLine === "*** End of File") {
          isEndOfFile = true;
          i++;
          break;
        }

        if (changeLine.startsWith(" ")) {
          const content = changeLine.substring(1);
          oldLines.push(content);
          newLines.push(content);
        } else if (changeLine.startsWith("-")) {
          oldLines.push(changeLine.substring(1));
        } else if (changeLine.startsWith("+")) {
          newLines.push(changeLine.substring(1));
        }

        i++;
      }

      chunks.push({
        old_lines: oldLines,
        new_lines: newLines,
        change_context: contextLine || undefined,
        is_end_of_file: isEndOfFile || undefined,
      });
    } else {
      i++;
    }
  }

  return { chunks, nextIdx: i };
}

function parseAddFileContent(
  lines: string[],
  startIdx: number,
): { content: string; nextIdx: number } {
  let content = "";
  let i = startIdx;

  while (i < lines.length && !lines[i].startsWith("***")) {
    if (lines[i].startsWith("+")) {
      content += `${lines[i].substring(1)}\n`;
    }
    i++;
  }

  if (content.endsWith("\n")) {
    content = content.slice(0, -1);
  }

  return { content, nextIdx: i };
}

function stripHeredoc(input: string): string {
  const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  if (heredocMatch) {
    return heredocMatch[2];
  }
  return input;
}

function parsePatch(patchText: string): { hunks: Hunk[] } {
  const cleaned = stripHeredoc(patchText.trim());
  const lines = cleaned.split("\n");
  const hunks: Hunk[] = [];

  const beginIdx = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const endIdx = lines.findIndex((line) => line.trim() === "*** End Patch");

  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  let i = beginIdx + 1;

  while (i < endIdx) {
    const header = parsePatchHeader(lines, i);
    if (!header) {
      i++;
      continue;
    }

    if (lines[i].startsWith("*** Add File:")) {
      const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx);
      hunks.push({
        type: "add",
        path: header.filePath,
        contents: content,
      });
      i = nextIdx;
    } else if (lines[i].startsWith("*** Delete File:")) {
      hunks.push({
        type: "delete",
        path: header.filePath,
      });
      i = header.nextIdx;
    } else if (lines[i].startsWith("*** Update File:")) {
      const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx);
      hunks.push({
        type: "update",
        path: header.filePath,
        move_path: header.movePath,
        chunks,
      });
      i = nextIdx;
    } else {
      i++;
    }
  }

  return { hunks };
}

function deriveNewContentsFromChunks(
  filePath: string,
  chunks: UpdateFileChunk[],
): { unified_diff: string; content: string } {
  let originalContent: string;
  try {
    originalContent = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read file ${filePath}: ${error}`);
  }

  const originalLines = originalContent.split("\n");

  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }

  const replacements = computeReplacements(originalLines, filePath, chunks);
  const newLines = applyReplacements(originalLines, replacements);

  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
    newLines.push("");
  }

  const newContent = newLines.join("\n");
  const unifiedDiff = generateUnifiedDiff(originalContent, newContent);

  return {
    unified_diff: unifiedDiff,
    content: newContent,
  };
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.change_context) {
      const contextIdx = seekSequence(originalLines, [chunk.change_context], lineIndex);
      if (contextIdx === -1) {
        throw new Error(`Failed to find context '${chunk.change_context}' in ${filePath}`);
      }
      lineIndex = contextIdx + 1;
    }

    if (chunk.old_lines.length === 0) {
      const insertionIdx =
        originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push([insertionIdx, 0, chunk.new_lines]);
      continue;
    }

    let pattern = chunk.old_lines;
    let newSlice = chunk.new_lines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);

    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
    }

    if (found !== -1) {
      replacements.push([found, pattern.length, newSlice]);
      lineIndex = found + pattern.length;
    } else {
      throw new Error(
        `Failed to find expected lines in ${filePath}:\n${chunk.old_lines.join("\n")}`,
      );
    }
  }

  replacements.sort((a, b) => a[0] - b[0]);

  return replacements;
}

function applyReplacements(
  lines: string[],
  replacements: Array<[number, number, string[]]>,
): string[] {
  const result = [...lines];

  for (let i = replacements.length - 1; i >= 0; i--) {
    const [startIdx, oldLen, newSegment] = replacements[i];
    result.splice(startIdx, oldLen);
    for (let j = 0; j < newSegment.length; j++) {
      result.splice(startIdx + j, 0, newSegment[j]);
    }
  }

  return result;
}

function normalizeUnicode(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

function tryMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: (a: string, b: string) => boolean,
  eof: boolean,
): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex) {
      let matches = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!compare(lines[fromEnd + j], pattern[j])) {
          matches = false;
          break;
        }
      }
      if (matches) return fromEnd;
    }
  }

  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    let matches = true;
    for (let j = 0; j < pattern.length; j++) {
      if (!compare(lines[i + j], pattern[j])) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }

  return -1;
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
  if (pattern.length === 0) return -1;

  const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof);
  if (exact !== -1) return exact;

  const rstrip = tryMatch(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof);
  if (rstrip !== -1) return rstrip;

  const trim = tryMatch(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), eof);
  if (trim !== -1) return trim;

  return tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
    eof,
  );
}

function generateUnifiedDiff(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let diff = "@@ -1 +1 @@\n";
  const maxLen = Math.max(oldLines.length, newLines.length);
  let hasChanges = false;

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i] || "";
    const newLine = newLines[i] || "";

    if (oldLine !== newLine) {
      if (oldLine) diff += `-${oldLine}\n`;
      if (newLine) diff += `+${newLine}\n`;
      hasChanges = true;
    } else if (oldLine) {
      diff += ` ${oldLine}\n`;
    }
  }

  return hasChanges ? diff : "";
}

function trimDiff(diff: string): string {
  const lines = diff.split("\n");
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  );

  if (contentLines.length === 0) return diff;

  let min = Infinity;
  for (const line of contentLines) {
    const content = line.slice(1);
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/);
      if (match) min = Math.min(min, match[1].length);
    }
  }
  if (min === Infinity || min === 0) return diff;

  return lines
    .map((line) => {
      if (
        (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
        !line.startsWith("---") &&
        !line.startsWith("+++")
      ) {
        const prefix = line[0];
        const content = line.slice(1);
        return prefix + content.slice(min);
      }
      return line;
    })
    .join("\n");
}
