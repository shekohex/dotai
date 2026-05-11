import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { hasPlanBrowserHtml } from "./plannotator-events.js";
import { getToolsForPhase, stripPlanningOnlyTools, type Phase } from "./tool-scope.js";
import { getPlanReviewAvailabilityWarning, type SavedPhaseState } from "./plannotator-support.js";

function updateWidget(ctx: ExtensionContext): void {
  ctx.ui.setWidget("plannotator-progress", undefined);
}

async function applyModelRef(
  pi: ExtensionAPI,
  ref: { provider: string; id: string },
  ctx: ExtensionContext,
  reason: string,
): Promise<void> {
  const model = ctx.modelRegistry.find(ref.provider, ref.id);
  if (model === undefined) {
    ctx.ui.notify(`Plannotator: ${reason} model ${ref.provider}/${ref.id} not found.`, "warning");
    return;
  }
  const success = await pi.setModel(model);
  if (!success) {
    ctx.ui.notify(`Plannotator: no API key for ${ref.provider}/${ref.id}.`, "warning");
  }
}

function applyToolState(args: {
  pi: ExtensionAPI;
  phase: Phase;
  savedState: SavedPhaseState | null;
}): void {
  if (args.phase !== "planning" && args.phase !== "executing") return;
  const baseTools = stripPlanningOnlyTools(
    args.savedState?.activeTools ?? args.pi.getActiveTools(),
  );
  args.pi.setActiveTools(getToolsForPhase(baseTools, args.phase));
}

export function createPlannotatorPhaseRuntime(args: {
  pi: ExtensionAPI;
  getPhase: () => Phase;
  setPhase: (phase: Phase) => void;
  getLastSubmittedPath: () => string | null;
  setLastSubmittedPath: (path: string | null) => void;
  getSavedState: () => SavedPhaseState | null;
  setSavedState: (state: SavedPhaseState | null) => void;
}) {
  function updateStatus(ctx: ExtensionContext): void {
    if (args.getPhase() === "planning") {
      ctx.ui.setStatus("plannotator", ctx.ui.theme.fg("warning", "planning"));
      return;
    }
    if (args.getPhase() === "executing") {
      ctx.ui.setStatus("plannotator", ctx.ui.theme.fg("accent", "executing"));
      return;
    }
    ctx.ui.setStatus("plannotator", undefined);
  }

  function captureSavedState(ctx: ExtensionContext): void {
    args.setSavedState({
      activeTools: args.pi.getActiveTools(),
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      thinkingLevel: args.pi.getThinkingLevel(),
    });
  }

  function persistState(): void {
    args.pi.appendEntry("plannotator", {
      phase: args.getPhase(),
      lastSubmittedPath: args.getLastSubmittedPath(),
      savedState: args.getSavedState(),
    });
  }

  async function restoreSavedState(ctx: ExtensionContext): Promise<void> {
    const savedState = args.getSavedState();
    if (savedState === null) return;
    args.pi.setActiveTools(savedState.activeTools);
    if (savedState.model !== undefined) {
      await applyModelRef(args.pi, savedState.model, ctx, "restore");
    }
    args.pi.setThinkingLevel(savedState.thinkingLevel);
  }

  async function applyPhaseConfig(
    ctx: ExtensionContext,
    opts: { restoreSavedState?: boolean } = {},
  ): Promise<void> {
    const savedState = args.getSavedState();
    const phase = args.getPhase();
    if (opts.restoreSavedState !== false && savedState !== null) {
      await restoreSavedState(ctx);
    }
    applyToolState({ pi: args.pi, phase, savedState });
    updateStatus(ctx);
    updateWidget(ctx);
  }

  async function enterPlanning(ctx: ExtensionContext): Promise<void> {
    args.setPhase("planning");
    captureSavedState(ctx);
    await applyPhaseConfig(ctx, { restoreSavedState: false });
    persistState();
    ctx.ui.notify("Plannotator: planning mode enabled.");
    const warning = getPlanReviewAvailabilityWarning({
      hasUI: ctx.hasUI,
      hasPlanHtml: hasPlanBrowserHtml(),
    });
    if (warning !== null) {
      ctx.ui.notify(warning, "warning");
    }
  }

  async function exitToIdle(ctx: ExtensionContext): Promise<void> {
    args.setPhase("idle");
    args.setLastSubmittedPath(null);
    await restoreSavedState(ctx);
    args.setSavedState(null);
    updateStatus(ctx);
    updateWidget(ctx);
    persistState();
    ctx.ui.notify("Plannotator: disabled. Full access restored.");
  }

  async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
    if (args.getPhase() === "idle") {
      await enterPlanning(ctx);
      return;
    }
    await exitToIdle(ctx);
  }

  return {
    updateStatus,
    updateWidget,
    captureSavedState,
    persistState,
    restoreSavedState,
    applyPhaseConfig,
    enterPlanning,
    exitToIdle,
    togglePlanMode,
  };
}
