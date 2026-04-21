import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ModeSpec, ModesFile } from "../../mode-utils.js";
import type { ModeChangeReason, ModeChangeSource } from "./events.js";
import { createModeRestoreHandlers } from "./restore.js";

type ModeRuntimeLike = {
  data: ModesFile;
  activeMode: string | undefined;
  error?: string;
};

type ModeChangedPayload = {
  mode: string | undefined;
  previousMode: string | undefined;
  spec: ModeSpec | undefined;
  reason: ModeChangeReason;
  source: ModeChangeSource;
  cwd: string;
};

type ModeActionDeps = {
  runtime: ModeRuntimeLike;
  modeStateEntry: string;
  ensureRuntime: (ctx: ExtensionContext) => Promise<void>;
  syncErrorUI: (ctx: ExtensionContext) => void;
  notifyConfigError: (ctx: ExtensionContext) => void;
  saveRuntime: (ctx: ExtensionContext) => Promise<void>;
  hasText: (value: string | undefined) => value is string;
  isThinkingLevel: (value: unknown) => value is NonNullable<ModeSpec["thinkingLevel"]>;
  currentSelection: (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
  ) => { provider?: string; modelId?: string; thinkingLevel: string };
  describeModeSpec: (spec: ModeSpec | undefined) => string | undefined;
  orderedModeNames: (data: ModesFile) => string[];
  getModeSpec: (data: ModesFile, modeName: string) => ModeSpec | undefined;
  applyMode: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    modeName: string,
    source: ModeChangeSource,
    reason?: ModeChangeReason,
    options?: { persist?: boolean },
  ) => Promise<boolean>;
  syncFromSelection: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    source: ModeChangeSource,
    options?: { notifyModeSwitch?: boolean; emitChangedEvent?: boolean },
  ) => Promise<void>;
  syncModeTools: (pi: ExtensionAPI, ctx: ExtensionContext, spec: ModeSpec | undefined) => void;
  setStatus: (ctx: ExtensionContext, modeName: string | undefined) => void;
  appendModeState: (pi: ExtensionAPI, activeMode: string | undefined) => void;
  emitModeChanged: (pi: ExtensionAPI, ctx: ExtensionContext, payload: ModeChangedPayload) => void;
  getStartupModeSelection: (pi: ExtensionAPI) => {
    selectedMode?: string;
    requestedModes: string[];
  };
  notifyStartupModeConflict: (ctx: ExtensionContext, requestedModes: string[]) => void;
};

async function storeModeWithDeps(
  deps: ModeActionDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modeName: string,
): Promise<void> {
  await deps.ensureRuntime(ctx);
  deps.syncErrorUI(ctx);
  const name = modeName.trim();
  if (!name) {
    ctx.ui.notify("Mode name cannot be empty", "warning");
    return;
  }

  const selection = deps.currentSelection(ctx, pi);
  const existing = deps.runtime.data.modes[name] ?? {};
  deps.runtime.data.modes[name] = {
    ...existing,
    provider: selection.provider,
    modelId: selection.modelId,
    thinkingLevel: deps.isThinkingLevel(selection.thinkingLevel)
      ? selection.thinkingLevel
      : undefined,
  };
  deps.runtime.data.currentMode = name;
  deps.runtime.activeMode = name;
  await deps.saveRuntime(ctx);
  deps.setStatus(ctx, name);
  deps.appendModeState(pi, name);
  deps.emitModeChanged(pi, ctx, {
    mode: name,
    previousMode: undefined,
    spec: deps.runtime.data.modes[name],
    reason: "store",
    source: "command",
    cwd: ctx.cwd,
  });
  const description = deps.describeModeSpec(deps.runtime.data.modes[name]);
  ctx.ui.notify(
    deps.hasText(description)
      ? `Stored and switched to mode "${name}" (${description})`
      : `Stored and switched to mode "${name}"`,
    "info",
  );
}

async function reloadModesWithDeps(
  deps: ModeActionDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  await deps.ensureRuntime(ctx);
  deps.syncErrorUI(ctx);
  if (deps.hasText(deps.runtime.error)) {
    deps.notifyConfigError(ctx);
    return;
  }

  if (
    deps.runtime.data.currentMode !== undefined &&
    deps.getModeSpec(deps.runtime.data, deps.runtime.data.currentMode) !== undefined
  ) {
    await deps.applyMode(pi, ctx, deps.runtime.data.currentMode, "command", "restore", {
      persist: false,
    });
    return;
  }

  await deps.syncFromSelection(pi, ctx, "command");
  ctx.ui.notify("Modes reloaded", "info");
}

export async function promptForModeName(
  ctx: ExtensionContext,
  title: string,
): Promise<string | undefined> {
  const value = await ctx.ui.input(title, "mode name");
  return value?.trim() ?? undefined;
}

async function showModePickerWithDeps(
  deps: ModeActionDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  await deps.ensureRuntime(ctx);
  deps.syncErrorUI(ctx);
  if (deps.hasText(deps.runtime.error)) {
    deps.notifyConfigError(ctx);
    return;
  }

  const names = deps.orderedModeNames(deps.runtime.data);
  const options = [...names, "store current setup", "reload modes"];
  const choice = await ctx.ui.select(`Mode (${deps.runtime.activeMode ?? "custom"})`, options);
  if (!deps.hasText(choice)) return;

  if (choice === "store current setup") {
    const name = await promptForModeName(ctx, "Store current setup as mode");
    if (!deps.hasText(name)) return;
    await storeModeWithDeps(deps, pi, ctx, name);
    return;
  }

  if (choice === "reload modes") {
    await reloadModesWithDeps(deps, pi, ctx);
    return;
  }

  await deps.applyMode(pi, ctx, choice, "command");
}

async function cycleModeWithDeps(
  deps: ModeActionDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  await deps.ensureRuntime(ctx);
  deps.syncErrorUI(ctx);
  if (deps.hasText(deps.runtime.error)) {
    deps.notifyConfigError(ctx);
    return;
  }

  const names = deps.orderedModeNames(deps.runtime.data);
  if (names.length === 0) {
    ctx.ui.notify("No modes defined. Use /mode store <name> to create one.", "warning");
    return;
  }

  const currentIndex =
    deps.runtime.activeMode === undefined ? -1 : names.indexOf(deps.runtime.activeMode);
  const nextIndex = (currentIndex + 1) % names.length;
  await deps.applyMode(pi, ctx, names[nextIndex], "shortcut", "cycle");
}

export function createModeActionHandlers(deps: ModeActionDeps) {
  const modeRestoreHandlers = createModeRestoreHandlers({
    runtime: deps.runtime,
    modeStateEntry: deps.modeStateEntry,
    ensureRuntime: deps.ensureRuntime,
    syncErrorUI: deps.syncErrorUI,
    notifyConfigError: deps.notifyConfigError,
    hasText: deps.hasText,
    getModeSpec: deps.getModeSpec,
    applyMode: deps.applyMode,
    syncFromSelection: deps.syncFromSelection,
    syncModeTools: deps.syncModeTools,
    setStatus: deps.setStatus,
    emitModeChanged: deps.emitModeChanged,
    getStartupModeSelection: deps.getStartupModeSelection,
    notifyStartupModeConflict: deps.notifyStartupModeConflict,
  });

  return {
    storeMode: (pi: ExtensionAPI, ctx: ExtensionContext, modeName: string) =>
      storeModeWithDeps(deps, pi, ctx, modeName),
    reloadModes: (pi: ExtensionAPI, ctx: ExtensionContext) => reloadModesWithDeps(deps, pi, ctx),
    promptForModeName,
    showModePicker: (pi: ExtensionAPI, ctx: ExtensionContext) =>
      showModePickerWithDeps(deps, pi, ctx),
    cycleMode: (pi: ExtensionAPI, ctx: ExtensionContext) => cycleModeWithDeps(deps, pi, ctx),
    restoreMode: modeRestoreHandlers.restoreMode,
    activateMode: modeRestoreHandlers.activateMode,
  };
}
