import { rename, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  SessionManager,
  SessionSelectorComponent,
  type ExtensionCommandContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { getArchivedDir, getSessionsRoot, usesDefaultLayout } from "./paths.js";
import { parseSessionInfos, type SessionListProgress } from "./parse-session-info.js";

async function listArchivedJsonl(archivedDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(archivedDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(archivedDir, entry.name));
}

async function listArchivedForCurrent(
  sessionDir: string,
  onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
  const files = await listArchivedJsonl(getArchivedDir(sessionDir));
  return parseSessionInfos(files, onProgress);
}

async function listArchivedForAll(
  root: string,
  onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
  let rootEntries: Dirent[];
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = rootEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
  const allFiles: string[] = [];
  for (const dir of dirs) {
    allFiles.push(...(await listArchivedJsonl(getArchivedDir(dir))));
  }
  return parseSessionInfos(allFiles, onProgress);
}

export async function moveArchivedBack(sessionPath: string): Promise<string> {
  const archivedDir = dirname(sessionPath);
  const sessionDir = dirname(archivedDir);
  const dest = join(sessionDir, basename(sessionPath));
  await rename(sessionPath, dest);
  return dest;
}

export async function showArchivePicker(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Archive picker requires interactive mode", "warning");
    return;
  }

  const root = getSessionsRoot();
  const sessionDir = ctx.sessionManager.getSessionDir();
  const defaultLayout = usesDefaultLayout(sessionDir, root);

  const selected = await ctx.ui.custom<string>((tui, _theme, keybindings, done) => {
    const selector = new SessionSelectorComponent(
      (onProgress) => listArchivedForCurrent(sessionDir, onProgress),
      (onProgress) =>
        defaultLayout
          ? listArchivedForAll(root, onProgress)
          : listArchivedForCurrent(sessionDir, onProgress),
      (sessionPath) => {
        void moveArchivedBack(sessionPath).then(
          (dest) => {
            done(dest);
          },
          () => {
            ctx.ui.notify("Failed to restore session", "error");
            done("");
          },
        );
      },
      () => {
        done("");
      },
      () => {
        done("");
      },
      () => {
        tui.requestRender();
      },
      {
        keybindings,
        renameSession: (sessionPath: string, nextName: string | undefined) => {
          const next = (nextName ?? "").trim();
          if (next.length > 0) {
            SessionManager.open(sessionPath).appendSessionInfo(next);
          }
          return Promise.resolve();
        },
        showRenameHint: true,
      },
      ctx.sessionManager.getSessionFile(),
    );
    return selector;
  });

  if (selected.length === 0) return;

  const result = await ctx.switchSession(selected, {
    withSession: (sessionCtx) => {
      sessionCtx.ui.notify("Restored archived session", "info");
      return Promise.resolve();
    },
  });
  if (result.cancelled) {
    ctx.ui.notify("Restore cancelled", "warning");
  }
}
