import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { hasRuntimePrimitive } from "../runtime-capabilities.js";
import { PromptStashBrowser, type PromptStashBrowserAction } from "./browser.js";
import {
  MAX_STASH_ENTRIES,
  STASH_VERSION,
  loadStashEntries,
  saveStashEntries,
  type PromptStashEntry,
} from "./storage.js";

const PROMPT_STASH_STATE_ENTRY = "prompt-stash-state";

const PromptStashStateEntrySchema = Type.Object(
  {
    version: Type.Literal(STASH_VERSION),
    id: Type.String(),
    text: Type.String(),
    createdAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const PromptStashStateSchema = Type.Object(
  {
    entries: Type.Array(PromptStashStateEntrySchema),
  },
  { additionalProperties: false },
);

export type { PromptStashEntry };
export { getStashFilePath, loadStashEntries, saveStashEntries } from "./storage.js";

function createStashEntry(text: string): PromptStashEntry {
  return {
    version: STASH_VERSION,
    id: randomUUID(),
    text,
    createdAt: Date.now(),
  };
}

function countLines(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function stashCurrentDraft(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const current = ctx.ui.getEditorText();
  if (current.trim().length === 0) {
    ctx.ui.notify("Nothing to stash", "info");
    return;
  }

  const entries = await readPersistedStashEntries(ctx);
  const nextEntries = [createStashEntry(current), ...entries].slice(0, MAX_STASH_ENTRIES);
  await persistStashEntries(pi, nextEntries, ctx);
  ctx.ui.setEditorText("");

  const pruned = Math.max(0, entries.length + 1 - MAX_STASH_ENTRIES);
  const suffix = pruned > 0 ? ` • pruned ${pruned} old ${pruned === 1 ? "entry" : "entries"}` : "";
  ctx.ui.notify(`Prompt stashed (${countLines(current)} lines)${suffix}`, "info");
}

async function popLatestEntry(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const entries = await readPersistedStashEntries(ctx);
  const entry = entries.at(0);

  if (entry === undefined) {
    ctx.ui.notify("No stashed prompts yet", "info");
    return;
  }

  await persistStashEntries(pi, entries.slice(1), ctx);
  ctx.ui.setEditorText(entry.text);
  ctx.ui.notify(`Applied latest stash entry (${countLines(entry.text)} lines)`, "info");
}

async function deleteStashEntry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  entryId: string,
): Promise<boolean> {
  const entries = await readPersistedStashEntries(ctx);
  const nextEntries = entries.filter((entry) => entry.id !== entryId);

  if (nextEntries.length === entries.length) {
    return false;
  }

  await persistStashEntries(pi, nextEntries, ctx);
  return true;
}

async function applyStashSelection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: PromptStashBrowserAction,
): Promise<void> {
  if (!action) {
    return;
  }

  switch (action.type) {
    case "open": {
      ctx.ui.setEditorText(action.entry.text);
      ctx.ui.notify(`Opened stash entry (${countLines(action.entry.text)} lines)`, "info");
      return;
    }

    case "pop": {
      const removed = await deleteStashEntry(pi, ctx, action.entry.id);
      if (!removed) {
        ctx.ui.notify("Selected stash entry no longer exists", "warning");
        return;
      }

      ctx.ui.setEditorText(action.entry.text);
      ctx.ui.notify(`Popped stash entry (${countLines(action.entry.text)} lines)`, "info");
      return;
    }

    case "delete": {
      const removed = await deleteStashEntry(pi, ctx, action.entry.id);
      if (!removed) {
        ctx.ui.notify("Selected stash entry no longer exists", "warning");
        return;
      }

      ctx.ui.notify("Deleted stash entry", "info");
    }
  }
}

async function showStashBrowser(ctx: ExtensionContext): Promise<PromptStashBrowserAction> {
  const entries = await readPersistedStashEntries(ctx);
  const draft = ctx.ui.getEditorText();

  if (!hasRuntimePrimitive(ctx, "custom")) {
    const fallbackAction = await showStashBrowserFallback(ctx, entries);
    if (!fallbackAction) {
      ctx.ui.setEditorText(draft);
    }
    return fallbackAction;
  }

  const result = await ctx.ui.custom<PromptStashBrowserAction>(
    (tui, theme, keybindings, done) =>
      new PromptStashBrowser(tui, theme, keybindings, entries, done),
    {
      overlay: true,
      overlayOptions: {
        width: "80%",
        maxHeight: "80%",
        anchor: "center",
      },
    },
  );

  if (!result) {
    ctx.ui.setEditorText(draft);
  }

  return result;
}

function readPersistedEntriesFromSessionEntries(
  sessionEntries: SessionEntry[],
): PromptStashEntry[] | undefined {
  for (const entry of [...sessionEntries].toReversed()) {
    if (entry.type !== "custom" || entry.customType !== PROMPT_STASH_STATE_ENTRY) {
      continue;
    }

    if (!Value.Check(PromptStashStateSchema, entry.data)) {
      continue;
    }

    const parsed = Value.Parse(PromptStashStateSchema, entry.data);
    return parsed.entries.slice(0, MAX_STASH_ENTRIES);
  }

  return undefined;
}

function readPersistedStashEntries(ctx: ExtensionContext): Promise<PromptStashEntry[]> {
  const persisted = readPersistedEntriesFromSessionEntries(ctx.sessionManager.getBranch());
  if (persisted !== undefined) {
    return Promise.resolve(persisted);
  }

  return loadStashEntries(ctx.cwd);
}

async function persistStashEntries(
  pi: ExtensionAPI,
  entries: PromptStashEntry[],
  ctx: ExtensionContext,
): Promise<void> {
  const nextEntries = entries.slice(0, MAX_STASH_ENTRIES);
  await saveStashEntries(ctx.cwd, nextEntries).catch(() => {});
  pi.appendEntry(PROMPT_STASH_STATE_ENTRY, { entries: nextEntries });
}

async function showStashBrowserFallback(
  ctx: ExtensionContext,
  entries: PromptStashEntry[],
): Promise<PromptStashBrowserAction> {
  if (entries.length === 0) {
    ctx.ui.notify("No stashed prompts yet", "info");
    return null;
  }

  const options = entries.map((entry, index) => {
    const headline = entry.text.replaceAll(/\s+/g, " ").trim();
    const preview = headline.length > 64 ? `${headline.slice(0, 63)}…` : headline;
    return `${index + 1}. ${preview.length > 0 ? preview : "(empty)"}`;
  });

  const selectedLabel = await ctx.ui.select("Select stash entry", options);
  if (selectedLabel === undefined || selectedLabel.length === 0) {
    return null;
  }

  const selectedIndex = options.findIndex((option) => option === selectedLabel);
  const selectedEntry = selectedIndex >= 0 ? entries[selectedIndex] : undefined;
  if (selectedEntry === undefined) {
    return null;
  }

  const selectedAction = await ctx.ui.select("Stash action", ["Open", "Pop", "Delete"]);
  if (selectedAction === "Open") {
    return { type: "open", entry: selectedEntry };
  }
  if (selectedAction === "Pop") {
    return { type: "pop", entry: selectedEntry };
  }
  if (selectedAction === "Delete") {
    return { type: "delete", entry: selectedEntry };
  }
  return null;
}

async function runStashAction(ctx: ExtensionContext, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    ctx.ui.notify(`Prompt stash failed: ${describeError(error)}`, "error");
  }
}

export default function promptStashExtension(pi: ExtensionAPI): void {
  pi.registerCommand("stash", {
    description: "Manage stashed prompts",
    handler: async (args, ctx) => {
      await runStashAction(ctx, async () => {
        if (!ctx.hasUI) {
          ctx.ui.notify("stash requires interactive mode", "error");
          return;
        }

        const trimmed = args.trim();
        if (trimmed === "") {
          const action = await showStashBrowser(ctx);
          await applyStashSelection(pi, ctx, action);
          return;
        }

        if (trimmed === "pop") {
          await popLatestEntry(pi, ctx);
          return;
        }

        ctx.ui.notify("Usage: /stash or /stash pop", "warning");
      });
    },
  });

  pi.registerShortcut(Key.ctrlAlt("s"), {
    description: "Stash current prompt",
    handler: async (ctx) => {
      await runStashAction(ctx, async () => {
        if (!ctx.hasUI) {
          ctx.ui.notify("stash requires interactive mode", "error");
          return;
        }

        await stashCurrentDraft(pi, ctx);
      });
    },
  });
}
