/**
 * Incremental workflow extension.
 *
 * Adds two slash commands for long-running repo sessions: - /marker: mark the current conversation
 * point as the baseline checkpoint - /end: roll up work since /marker into a branch summary, jump
 * back, and advance the marker
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createMarkerApi } from "./marker-api.js";

export { createMarkerApi, getSemanticLeafId, readMarkerStateFromBranch } from "./marker-api.js";
export type { MarkerApi, MarkerApiOptions, MarkerState } from "./marker-api.js";

export const INCREMENTAL_WORKFLOW_STATE_ENTRY = "incremental-workflow-state";
export const INCREMENTAL_WORKFLOW_MARKER_LABEL = "marker";
export const INCREMENTAL_WORKFLOW_END_WIDGET = "auto-trees-end";
export const INCREMENTAL_WORKFLOW_DEFAULT_END_PROMPT = [
  "Treat this as a finished work increment that should become durable context for continuing the same repository session.",
  "Focus on the final accepted outcome, not dead ends or step-by-step implementation noise.",
  "Capture the concrete code or repo changes, key decisions, important constraints, and any follow-up that still matters.",
  "Mention relevant files, commands, commits, PR outcomes, or review feedback only when they change future work.",
  "Omit temporary debugging details, abandoned attempts, and incidental churn that no longer matters.",
  "Write the summary so a future agent can continue from the repo familiarization and planning context plus this completed increment.",
].join("\n");
export const INCREMENTAL_WORKFLOW_GIT_END_PROMPT = [
  INCREMENTAL_WORKFLOW_DEFAULT_END_PROMPT,
  "Also explicitly capture the git commit that should be made for the completed changes, including a concise commit subject and any important commit-body notes.",
].join("\n");

type EndMode =
  | { mode: "default" }
  | { mode: "git" }
  | { mode: "full" }
  | { mode: "custom"; prompt: string };

const END_AUTOCOMPLETE_ITEMS: AutocompleteItem[] = [
  { value: "git", label: "git", description: "Summarize increment and include commit notes" },
  { value: "full", label: "full", description: "Use Pi default branch-summary prompt" },
  {
    value: "focus on ",
    label: "focus on <topic>",
    description: "Add custom summary focus instructions",
  },
];

function parseEndMode(args: string): EndMode {
  const trimmed = args.trim();
  if (!trimmed) return { mode: "default" };
  if (trimmed.toLowerCase() === "git") return { mode: "git" };
  if (trimmed.toLowerCase() === "full") return { mode: "full" };
  return { mode: "custom", prompt: trimmed };
}

function buildEndNavigationOptions(mode: EndMode): {
  summarize: true;
  customInstructions?: string;
  replaceInstructions?: boolean;
} {
  switch (mode.mode) {
    case "full":
      return { summarize: true };
    case "git":
      return {
        summarize: true,
        customInstructions: INCREMENTAL_WORKFLOW_GIT_END_PROMPT,
        replaceInstructions: false,
      };
    case "custom":
      return {
        summarize: true,
        customInstructions: mode.prompt,
        replaceInstructions: false,
      };
    case "default":
      return {
        summarize: true,
        customInstructions: INCREMENTAL_WORKFLOW_DEFAULT_END_PROMPT,
        replaceInstructions: false,
      };
  }

  return { summarize: true };
}

function getEndArgumentCompletions(prefix: string): AutocompleteItem[] {
  return END_AUTOCOMPLETE_ITEMS.filter((item) => item.value.startsWith(prefix));
}

export default function autoTreesExtension(pi: ExtensionAPI) {
  const markerApi = createMarkerApi(pi, {
    stateEntryType: INCREMENTAL_WORKFLOW_STATE_ENTRY,
    markerLabel: INCREMENTAL_WORKFLOW_MARKER_LABEL,
  });

  pi.on("session_start", (_event, ctx) => {
    markerApi.readState(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    markerApi.readState(ctx);
  });

  pi.registerCommand("marker", {
    description: "Mark the current conversation point as the incremental workflow checkpoint",
    getArgumentCompletions: () => [],
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const targetId = markerApi.getSemanticLeafId(ctx);
      const currentMarkerId = markerApi.readState(ctx)?.markerId;
      if (targetId === undefined || targetId.length === 0) {
        ctx.ui.notify("No conversation point to mark yet", "warning");
        return;
      }

      if (currentMarkerId === targetId) {
        ctx.ui.notify("Marker already points here", "info");
        return;
      }

      markerApi.applyMarker(ctx, targetId, "Marker set");
    },
  });

  pi.registerCommand("end", {
    description: "Roll up work since /marker into a summary and advance the marker",
    getArgumentCompletions: getEndArgumentCompletions,
    handler: async (args, ctx) => {
      const clearEndFeedback = () => {
        if (ctx.hasUI) {
          ctx.ui.setWidget(INCREMENTAL_WORKFLOW_END_WIDGET, undefined);
        }
        ctx.ui.setWorkingMessage();
      };

      await ctx.waitForIdle();

      const markerId = markerApi.readState(ctx)?.markerId;
      if (markerId === undefined || markerId.length === 0) {
        ctx.ui.notify("No marker set. Run /marker first", "warning");
        return;
      }

      if (!ctx.sessionManager.getEntry(markerId)) {
        ctx.ui.notify(
          "Stored marker no longer exists on this session. Run /marker again",
          "warning",
        );
        return;
      }

      const currentSemanticLeafId = markerApi.getSemanticLeafId(ctx);
      if (currentSemanticLeafId === markerId) {
        ctx.ui.notify("Nothing new since the current marker", "info");
        return;
      }

      ctx.ui.setWorkingMessage(ctx.ui.theme.fg("dim", "Summarizing increment…"));
      if (ctx.hasUI) {
        ctx.ui.setWidget(
          INCREMENTAL_WORKFLOW_END_WIDGET,
          [ctx.ui.theme.fg("dim", "Summarizing back to marker...")],
          { placement: "aboveEditor" },
        );
      }

      let result: Awaited<ReturnType<typeof ctx.navigateTree>>;
      try {
        result = await ctx.navigateTree(markerId, buildEndNavigationOptions(parseEndMode(args)));
      } finally {
        clearEndFeedback();
      }

      if (result.cancelled) {
        ctx.ui.notify("/end cancelled", "warning");
        return;
      }

      const nextMarkerId = markerApi.getSemanticLeafId(ctx);
      if (nextMarkerId === undefined || nextMarkerId.length === 0) {
        ctx.ui.notify("/end completed but no new marker point was found", "warning");
        return;
      }

      markerApi.applyMarker(ctx, nextMarkerId, "Increment summarized and marker advanced", {
        previousMarkerId: markerId,
      });
    },
  });
}
