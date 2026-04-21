import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ModeSpec } from "../../mode-utils.js";
import {
  applyModeModelSelection,
  applySelectionModel,
  inferModeFromSelection,
} from "./apply-selection.js";
import type { ModeApplyDeps } from "./apply-types.js";
import type { ModeChangeReason, ModeChangeSource, ModeSelectionApplyEvent } from "./events.js";

function handleSyncError(
  deps: ModeApplyDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  source: ModeChangeSource,
): void {
  const previousMode = deps.runtime.activeMode;
  deps.runtime.activeMode = undefined;
  deps.setStatus(ctx, undefined);
  if (previousMode !== undefined) {
    deps.emitModeChanged(pi, ctx, {
      mode: undefined,
      previousMode,
      spec: undefined,
      reason: "sync",
      source,
      cwd: ctx.cwd,
    });
  }
}

async function syncFromSelectionWithDeps(
  deps: ModeApplyDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  source: ModeChangeSource,
  options: { notifyModeSwitch?: boolean; emitChangedEvent?: boolean } = {},
): Promise<void> {
  const emitChangedEvent = options.emitChangedEvent ?? true;
  await deps.ensureRuntime(ctx);
  deps.syncErrorUI(ctx);
  if (deps.hasText(deps.runtime.error)) {
    if (emitChangedEvent) {
      handleSyncError(deps, pi, ctx, source);
    }
    return;
  }

  const previousMode = deps.runtime.activeMode;
  const nextMode = deps.inferActiveMode(
    deps.runtime.data,
    deps.runtime.activeMode,
    deps.currentSelection(ctx, pi),
  );
  const nextSpec =
    nextMode === undefined ? undefined : deps.getModeSpec(deps.runtime.data, nextMode);
  deps.runtime.activeMode = nextMode;
  deps.syncModeTools(pi, ctx, nextSpec);
  deps.setStatus(ctx, nextMode);
  if (!emitChangedEvent || previousMode === nextMode) {
    return;
  }

  if (source === "model_select" && options.notifyModeSwitch !== false) {
    deps.notifyModeSwitch(ctx, nextMode, nextSpec);
  }
  deps.emitModeChanged(pi, ctx, {
    mode: nextMode,
    previousMode,
    spec: nextSpec,
    reason: "sync",
    source,
    cwd: ctx.cwd,
  });
}

async function applyResolvedModeWithDeps(
  deps: ModeApplyDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: {
    modeName: string;
    spec: ModeSpec;
    previousMode: string | undefined;
    reason: ModeChangeReason;
    source: ModeChangeSource;
    persist?: boolean;
  },
): Promise<boolean> {
  const modelReady = await applyModeModelSelection(
    pi,
    ctx,
    data.modeName,
    data.spec,
    deps.hasModelSelection,
  );
  if (!modelReady) {
    return false;
  }
  if (deps.hasText(data.spec.thinkingLevel)) {
    pi.setThinkingLevel(data.spec.thinkingLevel);
  }

  deps.syncModeTools(pi, ctx, data.spec);
  deps.runtime.activeMode = data.modeName;
  deps.runtime.data.currentMode = data.modeName;
  if (data.persist !== false) {
    await deps.saveRuntime(ctx);
  }
  finalizeAppliedMode(deps, pi, ctx, data);
  return true;
}

function finalizeAppliedMode(
  deps: ModeApplyDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: {
    modeName: string;
    spec: ModeSpec;
    previousMode: string | undefined;
    reason: ModeChangeReason;
    source: ModeChangeSource;
  },
): void {
  deps.setStatus(ctx, data.modeName);
  deps.appendModeState(pi, data.modeName);
  deps.emitModeChanged(pi, ctx, {
    mode: data.modeName,
    previousMode: data.previousMode,
    spec: data.spec,
    reason: data.reason,
    source: data.source,
    cwd: ctx.cwd,
  });
  if (
    data.previousMode !== data.modeName &&
    (data.source === "command" || data.source === "shortcut")
  ) {
    deps.notifyModeSwitch(ctx, data.modeName, data.spec);
  }
}

async function applySelectionToRuntimeWithDeps(
  deps: ModeApplyDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ModeSelectionApplyEvent,
  previousMode: string | undefined,
): Promise<boolean> {
  if (!(await applySelectionModel(pi, ctx, event))) {
    return false;
  }
  if (event.thinkingLevel !== undefined) {
    pi.setThinkingLevel(event.thinkingLevel);
  }

  const nextMode = inferModeFromSelection(pi, ctx, event, {
    data: deps.runtime.data,
    activeMode: deps.runtime.activeMode,
    getModeSpec: deps.getModeSpec,
    selectionSatisfiesMode: deps.selectionSatisfiesMode,
    inferActiveMode: deps.inferActiveMode,
    currentSelection: deps.currentSelection,
  });
  const nextSpec =
    nextMode === undefined ? undefined : deps.getModeSpec(deps.runtime.data, nextMode);
  deps.runtime.activeMode = nextMode;
  deps.syncModeTools(pi, ctx, nextSpec);
  deps.setStatus(ctx, nextMode);
  deps.appendModeState(pi, nextMode);
  deps.emitModeChanged(pi, ctx, {
    mode: nextMode,
    previousMode,
    spec: nextSpec,
    reason: event.reason,
    source: event.source,
    cwd: ctx.cwd,
  });
  return true;
}

async function withApplyLock<T>(
  deps: ModeApplyDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: () => Promise<T>,
): Promise<T> {
  deps.runtime.applying = true;
  try {
    return await action();
  } finally {
    deps.runtime.applying = false;
    if (deps.runtime.needsResyncAfterApply) {
      deps.runtime.needsResyncAfterApply = false;
      await syncFromSelectionWithDeps(deps, pi, ctx, "before_agent_start", {
        notifyModeSwitch: false,
        emitChangedEvent: false,
      });
    }
  }
}

async function applyModeWithDeps(
  deps: ModeApplyDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modeName: string,
  source: ModeChangeSource,
  reason: ModeChangeReason = "apply",
  options: { persist?: boolean } = {},
): Promise<boolean> {
  if (!(await deps.ensureModesReady(ctx))) {
    return false;
  }

  const spec = deps.getModeSpec(deps.runtime.data, modeName);
  if (!spec) {
    ctx.ui.notify(`Unknown mode "${modeName}"`, "warning");
    return false;
  }

  const previousMode = deps.runtime.activeMode;
  return withApplyLock(deps, pi, ctx, () =>
    applyResolvedModeWithDeps(deps, pi, ctx, {
      modeName,
      spec,
      previousMode,
      reason,
      source,
      persist: options.persist,
    }),
  );
}

async function applySelectionWithDeps(
  deps: ModeApplyDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ModeSelectionApplyEvent,
): Promise<void> {
  if (!(await deps.ensureModesReady(ctx))) {
    return;
  }

  const previousMode = deps.runtime.activeMode;
  await withApplyLock(deps, pi, ctx, () =>
    applySelectionToRuntimeWithDeps(deps, pi, ctx, event, previousMode),
  );
}

export function createModeApplyActions(deps: ModeApplyDeps) {
  return {
    syncFromSelection: (
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      source: ModeChangeSource,
      options: { notifyModeSwitch?: boolean; emitChangedEvent?: boolean } = {},
    ) => syncFromSelectionWithDeps(deps, pi, ctx, source, options),
    applyMode: (
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      modeName: string,
      source: ModeChangeSource,
      reason: ModeChangeReason = "apply",
      options: { persist?: boolean } = {},
    ) => applyModeWithDeps(deps, pi, ctx, modeName, source, reason, options),
    applySelection: (pi: ExtensionAPI, ctx: ExtensionContext, event: ModeSelectionApplyEvent) =>
      applySelectionWithDeps(deps, pi, ctx, event),
  };
}
