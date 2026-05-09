import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  hasText: (value: string | undefined) => value is string;
  describeModeSpec: (spec: ModeSpec | undefined) => string | undefined;
  orderedModeNames: (data: ModesFile) => string[];
  getModeSpec: (data: ModesFile, modeName: string) => ModeSpec | undefined;
  applyMode: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    modeName: string,
    source: ModeChangeSource,
    reason?: ModeChangeReason,
    options?: { persist?: boolean; appendState?: boolean },
  ) => Promise<boolean>;
  syncFromSelection: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    source: ModeChangeSource,
    options?: {
      notifyModeSwitch?: boolean;
      emitChangedEvent?: boolean;
      appendState?: boolean;
    },
  ) => Promise<void>;
  syncModeTools: (pi: ExtensionAPI, ctx: ExtensionContext, spec: ModeSpec | undefined) => void;
  setStatus: (ctx: ExtensionContext, modeName: string | undefined) => void;
  appendModeState: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    activeMode: string | undefined,
  ) => void;
  emitModeChanged: (pi: ExtensionAPI, ctx: ExtensionContext, payload: ModeChangedPayload) => void;
  getStartupModeSelection: (pi: ExtensionAPI) => {
    selectedMode?: string;
    requestedModes: string[];
  };
  notifyStartupModeConflict: (ctx: ExtensionContext, requestedModes: string[]) => void;
};

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
  const options = [...names];
  const choice = await ctx.ui.select(`Mode (${deps.runtime.activeMode ?? "custom"})`, options);
  if (!deps.hasText(choice)) return;

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
    ctx.ui.notify("No modes defined.", "warning");
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
    showModePicker: (pi: ExtensionAPI, ctx: ExtensionContext) =>
      showModePickerWithDeps(deps, pi, ctx),
    cycleMode: (pi: ExtensionAPI, ctx: ExtensionContext) => cycleModeWithDeps(deps, pi, ctx),
    restoreMode: modeRestoreHandlers.restoreMode,
    activateMode: modeRestoreHandlers.activateMode,
  };
}
