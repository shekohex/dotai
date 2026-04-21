import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserFileEntry } from "./browser-actions.js";

export const openDiff = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: BrowserFileEntry,
  gitRoot: string | null,
): Promise<void> => {
  if (gitRoot === null) {
    ctx.ui.notify("Git repository not found", "warning");
    return;
  }

  const relativePath = path.relative(gitRoot, target.resolvedPath).split(path.sep).join("/");
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pi-files-"));
  const tmpFile = path.join(tmpDir, path.basename(target.displayPath));

  const existsInHead = await pi.exec("git", ["cat-file", "-e", `HEAD:${relativePath}`], {
    cwd: gitRoot,
  });
  if (existsInHead.code === 0) {
    const result = await pi.exec("git", ["show", `HEAD:${relativePath}`], { cwd: gitRoot });
    if (result.code !== 0) {
      const errorMessage = result.stderr?.trim() || `Failed to diff ${target.displayPath}`;
      ctx.ui.notify(errorMessage, "error");
      return;
    }
    writeFileSync(tmpFile, result.stdout ?? "", "utf8");
  } else {
    writeFileSync(tmpFile, "", "utf8");
  }

  let workingPath = target.resolvedPath;
  if (!existsSync(target.resolvedPath)) {
    workingPath = path.join(tmpDir, `pi-files-working-${path.basename(target.displayPath)}`);
    writeFileSync(workingPath, "", "utf8");
  }

  const openResult = await pi.exec("zed-preview", ["--diff", tmpFile, workingPath], {
    cwd: gitRoot,
  });
  if (openResult.code !== 0) {
    const errorMessage =
      openResult.stderr?.trim() || `Failed to open diff for ${target.displayPath}`;
    ctx.ui.notify(errorMessage, "error");
  }
};
