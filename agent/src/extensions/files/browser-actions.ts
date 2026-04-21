import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, type TUI } from "@mariozechner/pi-tui";
import { hasRuntimePrimitive } from "../runtime-capabilities.js";
import { showActionSelector, type FileAction } from "./actions.js";
import { openDiff } from "./diff.js";

export type BrowserFileEntry = {
  canonicalPath: string;
  resolvedPath: string;
  displayPath: string;
  isDirectory: boolean;
  isTracked: boolean;
};

type EditCheckResult = {
  allowed: boolean;
  reason?: string;
  content?: string;
};

const MAX_EDIT_BYTES = 40 * 1024 * 1024;

const getEditableContent = (target: BrowserFileEntry): EditCheckResult => {
  if (!existsSync(target.resolvedPath)) {
    return { allowed: false, reason: "File not found" };
  }

  const stats = statSync(target.resolvedPath);
  if (stats.isDirectory()) {
    return { allowed: false, reason: "Directories cannot be edited" };
  }

  if (stats.size >= MAX_EDIT_BYTES) {
    return { allowed: false, reason: "File is too large" };
  }

  const buffer = readFileSync(target.resolvedPath);
  if (buffer.includes(0)) {
    return { allowed: false, reason: "File contains null bytes" };
  }

  return { allowed: true, content: buffer.toString("utf8") };
};

const openPath = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: BrowserFileEntry,
): Promise<void> => {
  if (!existsSync(target.resolvedPath)) {
    ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
    return;
  }

  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const result = await pi.exec(command, [target.resolvedPath]);
  if (result.code !== 0) {
    const errorMessage = result.stderr?.trim() || `Failed to open ${target.displayPath}`;
    ctx.ui.notify(errorMessage, "error");
  }
};

const openExternalEditor = (tui: TUI, editorCmd: string, content: string): string | null => {
  const tmpFile = path.join(os.tmpdir(), `pi-files-edit-${Date.now()}.txt`);

  try {
    writeFileSync(tmpFile, content, "utf8");
    tui.stop();

    const [editor, ...editorArgs] = editorCmd.split(" ");
    const result = spawnSync(editor, [...editorArgs, tmpFile], { stdio: "inherit" });

    if (result.status === 0) {
      return readFileSync(tmpFile, "utf8").replace(/\n$/, "");
    }

    return null;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {}
    tui.start();
    tui.requestRender(true);
  }
};

const editPath = async (
  ctx: ExtensionContext,
  target: BrowserFileEntry,
  content: string,
): Promise<void> => {
  if (!hasRuntimePrimitive(ctx, "custom")) {
    const updated = await ctx.ui.editor(`Edit ${target.displayPath}`, content);
    if (updated === undefined) {
      ctx.ui.notify("Edit cancelled", "info");
      return;
    }

    try {
      writeFileSync(target.resolvedPath, updated, "utf8");
    } catch {
      ctx.ui.notify(`Failed to save ${target.displayPath}`, "error");
    }
    return;
  }

  const visualEditor = process.env.VISUAL;
  const fallbackEditor = process.env.EDITOR;
  const editorCmd =
    visualEditor !== undefined && visualEditor.length > 0 ? visualEditor : fallbackEditor;
  if (editorCmd === undefined || editorCmd.length === 0) {
    ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
    return;
  }

  const updated = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const status = new Text(theme.fg("dim", `Opening ${editorCmd}...`));

    queueMicrotask(() => {
      const result = openExternalEditor(tui, editorCmd, content);
      done(result);
    });

    return status;
  });

  if (updated === null) {
    ctx.ui.notify("Edit cancelled", "info");
    return;
  }

  try {
    writeFileSync(target.resolvedPath, updated, "utf8");
  } catch {
    ctx.ui.notify(`Failed to save ${target.displayPath}`, "error");
  }
};

export const revealPath = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: BrowserFileEntry,
): Promise<void> => {
  if (!existsSync(target.resolvedPath)) {
    ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
    return;
  }

  const isDirectory = target.isDirectory || statSync(target.resolvedPath).isDirectory();
  let command = "open";
  let args: string[] = [];

  if (process.platform === "darwin") {
    args = isDirectory ? [target.resolvedPath] : ["-R", target.resolvedPath];
  } else {
    command = "xdg-open";
    args = [isDirectory ? target.resolvedPath : path.dirname(target.resolvedPath)];
  }

  const result = await pi.exec(command, args);
  if (result.code !== 0) {
    const errorMessage = result.stderr?.trim() || `Failed to reveal ${target.displayPath}`;
    ctx.ui.notify(errorMessage, "error");
  }
};

export const quickLookPath = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: BrowserFileEntry,
): Promise<void> => {
  if (process.platform !== "darwin") {
    ctx.ui.notify("Quick Look is only available on macOS", "warning");
    return;
  }

  if (!existsSync(target.resolvedPath)) {
    ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
    return;
  }

  const isDirectory = target.isDirectory || statSync(target.resolvedPath).isDirectory();
  if (isDirectory) {
    ctx.ui.notify("Quick Look only works on files", "warning");
    return;
  }

  const result = await pi.exec("qlmanage", ["-p", target.resolvedPath]);
  if (result.code !== 0) {
    const errorMessage = result.stderr?.trim() || `Failed to Quick Look ${target.displayPath}`;
    ctx.ui.notify(errorMessage, "error");
  }
};

const addFileToPrompt = (ctx: ExtensionContext, target: BrowserFileEntry): void => {
  const mentionTarget = target.displayPath || target.resolvedPath;
  const mention = `@${mentionTarget}`;
  const current = ctx.ui.getEditorText();
  const separator = current && !current.endsWith(" ") ? " " : "";
  ctx.ui.setEditorText(`${current}${separator}${mention}`);
  ctx.ui.notify(`Added ${mention} to prompt`, "info");
};

export async function handleFileBrowserSelection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  selected: BrowserFileEntry,
  quickAction: "diff" | null,
  gitRoot: string | null,
): Promise<void> {
  const editCheck = getEditableContent(selected);
  const canQuickLook = process.platform === "darwin" && !selected.isDirectory;
  const canDiff = selected.isTracked && !selected.isDirectory && Boolean(gitRoot);
  if (quickAction === "diff") {
    await openDiff(pi, ctx, selected, gitRoot);
    return;
  }

  const action = await showActionSelector(ctx, {
    canQuickLook,
    canEdit: editCheck.allowed,
    canDiff,
  });
  if (!action) {
    return;
  }

  await executeFileBrowserAction(pi, ctx, selected, action, editCheck, gitRoot);
}

async function executeFileBrowserAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  selected: BrowserFileEntry,
  action: FileAction,
  editCheck: EditCheckResult,
  gitRoot: string | null,
): Promise<void> {
  if (action === "reveal") {
    await revealPath(pi, ctx, selected);
    return;
  }
  if (action === "quicklook") {
    await quickLookPath(pi, ctx, selected);
    return;
  }
  if (action === "open") {
    await openPath(pi, ctx, selected);
    return;
  }
  if (action === "edit") {
    if (!editCheck.allowed || editCheck.content === undefined) {
      ctx.ui.notify(editCheck.reason ?? "File cannot be edited", "warning");
      return;
    }
    await editPath(ctx, selected, editCheck.content);
    return;
  }
  if (action === "addToPrompt") {
    addFileToPrompt(ctx, selected);
    return;
  }

  await openDiff(pi, ctx, selected, gitRoot);
}
