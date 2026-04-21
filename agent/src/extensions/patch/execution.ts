import { createTwoFilesPatch, diffLines } from "diff";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolUpdateCallback, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { deriveNewContentsFromChunks, trimDiff } from "./content.js";
import { parsePatch, summarizeHunks } from "./parser.js";
import { createPatchFileDetailsFromChanges, emitApplyPatchUpdate } from "./render.js";
import type {
  ApplyPatchDetails,
  Hunk,
  PatchFileChange,
  PatchTargetDetails,
  UpdateFileChunk,
} from "./types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parsePatchExecutionInput(patchText: string): {
  hunks: Hunk[];
  targets: PatchTargetDetails[];
} {
  if (patchText.length === 0) {
    throw new Error("patchText is required");
  }

  let hunks: Hunk[];
  try {
    hunks = parsePatch(patchText).hunks;
  } catch (error) {
    throw new Error(`apply_patch verification failed: ${errorMessage(error)}`, { cause: error });
  }

  if (hunks.length === 0) {
    const normalized = patchText.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
    if (normalized === "*** Begin Patch\n*** End Patch") {
      throw new Error("patch rejected: empty patch");
    }
    throw new Error("apply_patch verification failed: no hunks found");
  }

  return { hunks, targets: summarizeHunks(hunks) };
}

export async function applyPatchHunks(
  hunks: Hunk[],
  targets: PatchTargetDetails[],
  onUpdate: AgentToolUpdateCallback<ApplyPatchDetails> | undefined,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ApplyPatchDetails }> {
  const { fileChanges, totalDiff } = await collectPatchFileChanges(hunks, targets, onUpdate, ctx);
  const files = createPatchFileDetailsFromChanges(fileChanges, ctx);
  await commitPatchFileChanges(fileChanges);

  return {
    content: [{ type: "text", text: formatApplyPatchOutputSummary(fileChanges, ctx) }],
    details: {
      diff: totalDiff,
      files,
      targets,
      totalFiles: targets.length,
      completedFiles: files.length,
    },
  };
}

export function getQueuePaths(hunks: Hunk[], ctx: ExtensionContext): string[] {
  const unique = new Set<string>();
  for (const hunk of hunks) {
    unique.add(resolvePatchPath(ctx, hunk.path));
    if (hunk.type === "update" && hunk.move_path !== undefined && hunk.move_path.length > 0) {
      unique.add(resolvePatchPath(ctx, hunk.move_path));
    }
  }
  return Array.from(unique).toSorted();
}

function resolvePatchPath(ctx: ExtensionContext, filePath: string): string {
  const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  return path.resolve(ctx.cwd, normalized);
}

async function collectPatchFileChanges(
  hunks: Hunk[],
  targets: PatchTargetDetails[],
  onUpdate: AgentToolUpdateCallback<ApplyPatchDetails> | undefined,
  ctx: ExtensionContext,
): Promise<{ fileChanges: PatchFileChange[]; totalDiff: string }> {
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
    const change = await createPatchFileChange(hunk, ctx);
    fileChanges.push(change);
    totalDiff += `${change.diff}\n`;
    emitApplyPatchUpdate(onUpdate, {
      diff: totalDiff,
      files: createPatchFileDetailsFromChanges(fileChanges, ctx),
      targets,
      totalFiles: targets.length,
      completedFiles: fileChanges.length,
    });
  }

  return { fileChanges, totalDiff };
}

function createPatchFileChange(hunk: Hunk, ctx: ExtensionContext): Promise<PatchFileChange> {
  const filePath = resolvePatchPath(ctx, hunk.path);
  if (hunk.type === "add") {
    return Promise.resolve(createAddPatchFileChange(filePath, hunk));
  }
  if (hunk.type === "update") {
    return createUpdatePatchFileChange(filePath, hunk, ctx);
  }

  return createDeletePatchFileChange(filePath);
}

function createAddPatchFileChange(
  filePath: string,
  hunk: Extract<Hunk, { type: "add" }>,
): PatchFileChange {
  const oldContent = "";
  const newContent =
    hunk.contents.length === 0 || hunk.contents.endsWith("\n")
      ? hunk.contents
      : `${hunk.contents}\n`;
  const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent));
  const { additions, deletions } = countLineChanges(oldContent, newContent);
  return { filePath, oldContent, newContent, type: "add", diff, additions, deletions };
}

async function createUpdatePatchFileChange(
  filePath: string,
  hunk: Extract<Hunk, { type: "update" }>,
  ctx: ExtensionContext,
): Promise<PatchFileChange> {
  const stats = await fs.stat(filePath).catch(() => null);
  if (!stats || stats.isDirectory()) {
    throw new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`);
  }

  const oldContent = await fs.readFile(filePath, "utf-8");
  const newContent = deriveUpdatedPatchContent(filePath, hunk.chunks);
  const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent));
  const { additions, deletions } = countLineChanges(oldContent, newContent);
  const movePath =
    typeof hunk.move_path === "string" && hunk.move_path.length > 0
      ? resolvePatchPath(ctx, hunk.move_path)
      : undefined;
  return {
    filePath,
    oldContent,
    newContent,
    type: movePath !== undefined && movePath.length > 0 ? "move" : "update",
    movePath,
    diff,
    additions,
    deletions,
  };
}

function deriveUpdatedPatchContent(filePath: string, chunks: UpdateFileChunk[]): string {
  try {
    return deriveNewContentsFromChunks(filePath, chunks).content;
  } catch (error) {
    throw new Error(`apply_patch verification failed: ${errorMessage(error)}`, { cause: error });
  }
}

async function createDeletePatchFileChange(filePath: string): Promise<PatchFileChange> {
  const oldContent = await fs.readFile(filePath, "utf-8").catch((error) => {
    throw new Error(`apply_patch verification failed: ${errorMessage(error)}`);
  });
  const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, ""));
  return {
    filePath,
    oldContent,
    newContent: "",
    type: "delete",
    diff,
    additions: 0,
    deletions: oldContent.split("\n").length,
  };
}

function countLineChanges(
  oldContent: string,
  newContent: string,
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(oldContent, newContent)) {
    if (change.added) {
      additions += change.count || 0;
    }
    if (change.removed) {
      deletions += change.count || 0;
    }
  }

  return { additions, deletions };
}

async function commitPatchFileChanges(fileChanges: PatchFileChange[]): Promise<void> {
  for (const change of fileChanges) {
    if (change.type === "add") {
      await fs.mkdir(path.dirname(change.filePath), { recursive: true });
      await fs.writeFile(change.filePath, change.newContent, "utf-8");
      continue;
    }
    if (change.type === "update") {
      await fs.writeFile(change.filePath, change.newContent, "utf-8");
      continue;
    }
    if (change.type === "move") {
      if (change.movePath !== undefined && change.movePath.length > 0) {
        await fs.mkdir(path.dirname(change.movePath), { recursive: true });
        await fs.writeFile(change.movePath, change.newContent, "utf-8");
        await fs.unlink(change.filePath);
      }
      continue;
    }
    await fs.unlink(change.filePath);
  }
}

function formatApplyPatchOutputSummary(
  fileChanges: PatchFileChange[],
  ctx: ExtensionContext,
): string {
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
  return `Success. Updated the following files:\n${summaryLines.join("\n")}`;
}
