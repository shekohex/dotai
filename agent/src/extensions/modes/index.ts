import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import type { ModesFile, ModeSpec } from "../../mode-utils.js";
import { getModeArgumentCompletions as getModeCommandCompletions } from "./completions.js";
import {
  currentSelection,
  describeModeAutocomplete,
  describeModeSpec,
  getModeSpec,
  hasModelSelection,
  hasText,
  inferActiveMode,
  orderedModeNames,
  selectionSatisfiesMode,
} from "./core.js";
import { isThinkingLevel, parseModeActivateEvent, parseModeSelectionApplyEvent } from "./events.js";
import {
  createModeActionHandlers,
  createModeApplyActions,
  getStartupModeSelection,
  notifyStartupModeConflict,
  registerModeCommand,
  registerModeEventHandlers,
  registerModeFlags,
  registerModeLifecycleHandlers,
  registerModeShortcuts,
  syncModeTools,
  toModeFlagName,
} from "./orchestration.js";
import {
  ensureModesReady as ensureModesReadyRuntime,
  ensureRuntime as ensureRuntimeState,
  notifyConfigError as notifyConfigErrorState,
  saveRuntime as saveRuntimeState,
  syncErrorUI as syncErrorUIState,
} from "./runtime.js";

export const MODE_STATE_ENTRY = "mode-state";
export const MODE_ACTIVATE_EVENT = "modes:activate";
export const MODE_SELECTION_APPLY_EVENT = "modes:apply-selection";
const MODE_STATUS_KEY = "mode";
const CUSTOM_MODE_LABEL = "custom";

const registeredModeFlags = new Map<string, string>();

type ModeRuntime = {
  path: string;
  source: "project" | "global" | "missing";
  data: ModesFile;
  activeMode: string | undefined;
  applying: boolean;
  needsResyncAfterApply: boolean;
  error?: string;
  lastReportedError?: string;
  lastStatusText?: string;
};

export type ModeChangedEvent = {
  mode: string | undefined;
  previousMode: string | undefined;
  spec: ModeSpec | undefined;
  reason: "apply" | "store" | "restore" | "sync" | "cycle";
  source: "command" | "shortcut" | "session_start" | "model_select" | "before_agent_start";
  cwd: string;
};

const runtime: ModeRuntime = {
  path: "",
  source: "missing",
  data: { version: 1, currentMode: undefined, modes: {} },
  activeMode: undefined,
  applying: false,
  needsResyncAfterApply: false,
  error: undefined,
  lastReportedError: undefined,
  lastStatusText: undefined,
};

const MODE_ERROR_WIDGET_KEY = "mode-config-error";

export { toModeFlagName };

function getModeAutocompleteEntries(): Array<{ modeName: string; description?: string }> {
  return orderedModeNames(runtime.data).map((modeName) => ({
    modeName,
    description: describeModeAutocomplete(
      modeName,
      getModeSpec(runtime.data, modeName),
      runtime.activeMode,
    ),
  }));
}

function getModeArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return getModeCommandCompletions(argumentPrefix, getModeAutocompleteEntries());
}

function notifyModeSwitch(
  ctx: ExtensionContext,
  modeName: string | undefined,
  spec: ModeSpec | undefined,
): void {
  if (!ctx.hasUI) return;

  const label = modeName ?? CUSTOM_MODE_LABEL;
  const description = describeModeSpec(spec);
  ctx.ui.notify(
    hasText(description)
      ? `Switched mode to "${label}" (${description})`
      : `Switched mode to "${label}"`,
    "info",
  );
}

function setStatus(ctx: ExtensionContext, modeName: string | undefined): void {
  if (!ctx.hasUI) return;
  const text = ctx.ui.theme.fg(
    hasText(modeName) ? "accent" : "warning",
    `mode:${modeName ?? CUSTOM_MODE_LABEL}`,
  );
  if (runtime.lastStatusText === text) {
    return;
  }
  runtime.lastStatusText = text;
  ctx.ui.setStatus(MODE_STATUS_KEY, text);
}

function emitModeChanged(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  payload: ModeChangedEvent,
): void {
  pi.events.emit("modes:changed", payload);
}

function appendModeState(pi: ExtensionAPI, activeMode: string | undefined): void {
  if (!hasText(activeMode)) return;
  pi.appendEntry(MODE_STATE_ENTRY, { activeMode });
}

async function ensureRuntime(ctx: ExtensionContext): Promise<void> {
  await ensureRuntimeState(runtime, ctx, { hasText, getModeSpec });
}

function syncErrorUI(ctx: ExtensionContext): void {
  syncErrorUIState(runtime, ctx, MODE_ERROR_WIDGET_KEY, hasText);
}

function notifyConfigError(ctx: ExtensionContext): void {
  notifyConfigErrorState(runtime, ctx, hasText);
}

async function saveRuntime(_ctx: ExtensionContext): Promise<void> {
  await saveRuntimeState(runtime);
}

const modeApplyActions = createModeApplyActions({
  runtime,
  ensureRuntime,
  syncErrorUI,
  ensureModesReady,
  saveRuntime,
  getModeSpec,
  inferActiveMode,
  currentSelection,
  selectionSatisfiesMode,
  hasText,
  hasModelSelection,
  syncModeTools,
  setStatus,
  emitModeChanged,
  appendModeState,
  notifyModeSwitch,
});

const { syncFromSelection, applyMode, applySelection } = modeApplyActions;

function ensureModesReady(ctx: ExtensionContext): Promise<boolean> {
  return ensureModesReadyRuntime(runtime, ctx, {
    ensureRuntime: () => {
      return ensureRuntime(ctx);
    },
    syncErrorUI: () => {
      syncErrorUI(ctx);
    },
    notifyConfigError: () => {
      notifyConfigError(ctx);
    },
    hasText,
  });
}

const modeActionHandlers = createModeActionHandlers({
  runtime,
  modeStateEntry: MODE_STATE_ENTRY,
  ensureRuntime,
  syncErrorUI,
  notifyConfigError,
  saveRuntime,
  hasText,
  isThinkingLevel,
  currentSelection,
  describeModeSpec,
  orderedModeNames,
  getModeSpec,
  applyMode,
  syncFromSelection,
  syncModeTools,
  setStatus,
  appendModeState,
  emitModeChanged,
  getStartupModeSelection: (pi) => getStartupModeSelection(pi, registeredModeFlags),
  notifyStartupModeConflict,
});

const {
  storeMode,
  reloadModes,
  promptForModeName,
  showModePicker,
  cycleMode,
  restoreMode,
  activateMode,
} = modeActionHandlers;

export default function modesExtension(pi: ExtensionAPI): void {
  registerModeFlags(pi, registeredModeFlags, { orderedModeNames, describeModeSpec, hasText });
  registerModeCommand(pi, {
    getModeArgumentCompletions,
    showModePicker,
    promptForModeName,
    storeMode,
    reloadModes,
    applyMode,
  });
  registerModeShortcuts(pi, { showModePicker, cycleMode });
  registerModeLifecycleHandlers(pi, {
    resetRuntimeState: () => {
      runtime.path = "";
      runtime.activeMode = undefined;
    },
    restoreMode,
    isApplying: () => runtime.applying,
    markNeedsResyncAfterApply: () => {
      runtime.needsResyncAfterApply = true;
    },
    syncFromSelection,
    appendModeState,
    getActiveMode: () => runtime.activeMode,
    setStatus,
  });
  registerModeEventHandlers(pi, {
    modeActivateEvent: MODE_ACTIVATE_EVENT,
    modeSelectionApplyEvent: MODE_SELECTION_APPLY_EVENT,
    parseModeActivateEvent,
    activateMode,
    parseModeSelectionApplyEvent,
    applySelection,
  });
}
