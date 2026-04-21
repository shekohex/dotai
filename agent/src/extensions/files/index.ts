/**
 * Files Extension
 *
 * /files command lists files in the current git tree (plus session-referenced files) and offers
 * quick actions like reveal, open, edit, or diff. /diff is kept as an alias to the same picker.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { handleFileBrowserSelection, quickLookPath, revealPath } from "./browser-actions.js";
import { buildFileEntries } from "./entry-builder.js";
import type { FileEntry } from "./model.js";
import { toCanonicalPath } from "./path-utils.js";
import { findLatestFileReference } from "./references.js";
import { showFileSelector } from "./selector.js";

const runFileBrowser = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
  if (!ctx.hasUI) {
    ctx.ui.notify("Files requires interactive mode", "error");
    return;
  }

  const { files, gitRoot } = await buildFileEntries(pi, ctx);
  if (files.length === 0) {
    ctx.ui.notify("No files found", "info");
    return;
  }

  let lastSelectedPath: string | null = null;
  while (true) {
    const nextSelection = await showFileSelector(ctx, files, lastSelectedPath, gitRoot);
    if (nextSelection.selectedPath === null || nextSelection.selectedPath.length === 0) {
      ctx.ui.notify("Files cancelled", "info");
      return;
    }

    const selected =
      files.find((file) => file.canonicalPath === nextSelection.selectedPath) ?? null;
    if (selected === null) {
      ctx.ui.notify("File selection is no longer available", "warning");
      return;
    }

    lastSelectedPath = selected.canonicalPath;
    await handleFileBrowserSelection(pi, ctx, selected, nextSelection.quickAction, gitRoot);
  }
};

export default function (pi: ExtensionAPI): void {
  registerFileBrowserEntryPoints(pi);
  registerLatestReferenceShortcuts(pi);
}

function registerFileBrowserEntryPoints(pi: ExtensionAPI): void {
  pi.registerCommand("files", {
    description: "Browse files with git status and session references",
    handler: async (_args, ctx) => {
      await runFileBrowser(pi, ctx);
    },
  });

  pi.registerShortcut("ctrl+alt+o", {
    description: "Browse files mentioned in the session",
    handler: async (ctx) => {
      await runFileBrowser(pi, ctx);
    },
  });
}

function registerLatestReferenceShortcuts(pi: ExtensionAPI): void {
  registerLatestReferenceShortcut(pi, {
    shortcut: "ctrl+alt+f",
    description: "Reveal the latest file reference in Finder",
    open: (ctx, entry) => revealPath(pi, ctx, entry),
  });
  registerLatestReferenceShortcut(pi, {
    shortcut: "ctrl+alt+r",
    description: "Quick Look the latest file reference",
    open: (ctx, entry) => quickLookPath(pi, ctx, entry),
  });
}

function registerLatestReferenceShortcut(
  pi: ExtensionAPI,
  input: {
    shortcut: "ctrl+alt+f" | "ctrl+alt+r";
    description: string;
    open: (ctx: ExtensionContext, entry: FileEntry) => Promise<void>;
  },
): void {
  pi.registerShortcut(input.shortcut, {
    description: input.description,
    handler: async (ctx) => {
      const latest = findLatestSessionReferenceEntry(ctx);
      if (!latest) {
        return;
      }

      await input.open(ctx, latest);
    },
  });
}

function findLatestSessionReferenceEntry(ctx: ExtensionContext): FileEntry | null {
  const entries = ctx.sessionManager.getBranch();
  const latest = findLatestFileReference(entries, ctx.cwd);
  if (!latest) {
    ctx.ui.notify("No file reference found in the session", "warning");
    return null;
  }

  const canonical = toCanonicalPath(latest.path);
  if (!canonical) {
    ctx.ui.notify(`File not found: ${latest.display}`, "error");
    return null;
  }

  return {
    canonicalPath: canonical.canonicalPath,
    resolvedPath: canonical.canonicalPath,
    displayPath: latest.display,
    exists: true,
    isDirectory: canonical.isDirectory,
    status: undefined,
    inRepo: false,
    isTracked: false,
    isReferenced: true,
    hasSessionChange: false,
    lastTimestamp: 0,
  };
}
