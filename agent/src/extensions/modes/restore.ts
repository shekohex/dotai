import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ModeSpec, ModesFile } from "../../mode-utils.js";
import { readActiveModeFromEntry, type ModeActivateEvent } from "./events.js";

type ModeRuntimeLike = {
  data: ModesFile;
  activeMode: string | undefined;
  error?: string;
};

type ModeChangeReason = "apply" | "store" | "restore" | "sync" | "cycle";
type ModeChangeSource =
  | "command"
  | "shortcut"
  | "session_start"
  | "model_select"
  | "before_agent_start";

type ModeChangedPayload = {
  mode: string | undefined;
  previousMode: string | undefined;
  spec: ModeSpec | undefined;
  reason: ModeChangeReason;
  source: ModeChangeSource;
  cwd: string;
};

type ModeRestoreDeps = {
  runtime: ModeRuntimeLike;
  modeStateEntry: string;
  ensureRuntime: (ctx: ExtensionContext) => Promise<void>;
  syncErrorUI: (ctx: ExtensionContext) => void;
  notifyConfigError: (ctx: ExtensionContext) => void;
  hasText: (value: string | undefined) => value is string;
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
  emitModeChanged: (pi: ExtensionAPI, ctx: ExtensionContext, payload: ModeChangedPayload) => void;
  getStartupModeSelection: (pi: ExtensionAPI) => {
    selectedMode?: string;
    requestedModes: string[];
  };
  notifyStartupModeConflict: (ctx: ExtensionContext, requestedModes: string[]) => void;
};

function getSessionRestoreState(
  deps: ModeRestoreDeps,
  ctx: ExtensionContext,
): {
  sessionMode: string | undefined;
  hasExplicitSessionSelection: boolean;
} {
  const entries = ctx.sessionManager.getEntries();
  const modeEntries = entries.filter(
    (entry) => entry.type === "custom" && entry.customType === deps.modeStateEntry,
  );
  return {
    sessionMode: readActiveModeFromEntry(modeEntries.at(-1)),
    hasExplicitSessionSelection: entries.some(
      (entry) => entry.type === "model_change" || entry.type === "thinking_level_change",
    ),
  };
}

async function emitRestoreFromSelection(
  deps: ModeRestoreDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  await deps.syncFromSelection(pi, ctx, "session_start", { emitChangedEvent: false });
  deps.emitModeChanged(pi, ctx, {
    mode: deps.runtime.activeMode,
    previousMode: undefined,
    spec:
      deps.runtime.activeMode === undefined
        ? undefined
        : deps.getModeSpec(deps.runtime.data, deps.runtime.activeMode),
    reason: "restore",
    source: "session_start",
    cwd: ctx.cwd,
  });
}

async function tryRestoreFromStartupMode(
  deps: ModeRestoreDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<boolean> {
  const startupModeSelection = deps.getStartupModeSelection(pi);
  deps.notifyStartupModeConflict(ctx, startupModeSelection.requestedModes);
  if (startupModeSelection.selectedMode === undefined) {
    return false;
  }

  await deps.applyMode(pi, ctx, startupModeSelection.selectedMode, "session_start", "restore", {
    persist: false,
  });
  return true;
}

async function tryRestoreFromSessionMode(
  deps: ModeRestoreDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sessionMode: string | undefined,
): Promise<boolean> {
  if (sessionMode === undefined || deps.getModeSpec(deps.runtime.data, sessionMode) === undefined) {
    return false;
  }

  await deps.applyMode(pi, ctx, sessionMode, "session_start", "restore", { persist: false });
  return true;
}

async function tryRestoreFromPersistedMode(
  deps: ModeRestoreDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<boolean> {
  if (
    deps.runtime.data.currentMode === undefined ||
    deps.getModeSpec(deps.runtime.data, deps.runtime.data.currentMode) === undefined
  ) {
    return false;
  }

  await deps.applyMode(pi, ctx, deps.runtime.data.currentMode, "session_start", "restore", {
    persist: false,
  });
  return true;
}

async function restoreModeWithDeps(
  deps: ModeRestoreDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  await deps.ensureRuntime(ctx);
  deps.syncErrorUI(ctx);
  if (deps.hasText(deps.runtime.error)) {
    deps.notifyConfigError(ctx);
    deps.setStatus(ctx, undefined);
    deps.emitModeChanged(pi, ctx, {
      mode: undefined,
      previousMode: undefined,
      spec: undefined,
      reason: "restore",
      source: "session_start",
      cwd: ctx.cwd,
    });
    return;
  }

  if (await tryRestoreFromStartupMode(deps, pi, ctx)) return;

  const sessionRestoreState = getSessionRestoreState(deps, ctx);
  if (await tryRestoreFromSessionMode(deps, pi, ctx, sessionRestoreState.sessionMode)) return;
  if (sessionRestoreState.hasExplicitSessionSelection) {
    await emitRestoreFromSelection(deps, pi, ctx);
    return;
  }

  if (await tryRestoreFromPersistedMode(deps, pi, ctx)) return;
  await emitRestoreFromSelection(deps, pi, ctx);
}

async function activateModeWithDeps(
  deps: ModeRestoreDeps,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ModeActivateEvent,
): Promise<void> {
  await deps.ensureRuntime(ctx);
  deps.syncErrorUI(ctx);

  const previousMode = deps.runtime.activeMode;
  deps.runtime.activeMode = event.mode;
  deps.syncModeTools(pi, ctx, event.spec ?? deps.getModeSpec(deps.runtime.data, event.mode));
  deps.setStatus(ctx, event.mode);
  deps.emitModeChanged(pi, ctx, {
    mode: event.mode,
    previousMode,
    spec: event.spec ?? deps.getModeSpec(deps.runtime.data, event.mode),
    reason: event.reason,
    source: event.source,
    cwd: ctx.cwd,
  });
}

export function createModeRestoreHandlers(deps: ModeRestoreDeps) {
  return {
    restoreMode: (pi: ExtensionAPI, ctx: ExtensionContext) => restoreModeWithDeps(deps, pi, ctx),
    activateMode: (pi: ExtensionAPI, ctx: ExtensionContext, event: ModeActivateEvent) =>
      activateModeWithDeps(deps, pi, ctx, event),
  };
}
