import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

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
import {
  parseModeActivateEvent,
  parseModeSelectionApplyEvent,
  readActiveModeFromEntry,
} from "./events.js";
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
  subscribeModeFlagRefresh,
  syncModeTools,
  toModeFlagName,
} from "./orchestration.js";
import { extractPiDynamicTail } from "../model-family-system-prompt.js";
import {
  ensureModesReady as ensureModesReadyRuntime,
  ensureRuntime as ensureRuntimeState,
  notifyConfigError as notifyConfigErrorState,
  syncErrorUI as syncErrorUIState,
} from "./runtime.js";
import { isEphemeralSession } from "./session.js";

export const MODE_STATE_ENTRY = "mode-state";
export const MODE_ACTIVATE_EVENT = "modes:activate";
export const MODE_SELECTION_APPLY_EVENT = "modes:apply-selection";
const MODE_STATUS_KEY = "mode";
const CUSTOM_MODE_LABEL = "custom";

type ModeRuntime = {
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

function applyModeSystemPrompt(
  systemPrompt: string,
  spec: ModeSpec | undefined,
): string | undefined {
  if (spec?.systemPrompt === undefined || spec.systemPrompt.length === 0) {
    return undefined;
  }

  if (spec.systemPromptMode === "replace") {
    const tail = extractPiDynamicTail(systemPrompt).trimStart();
    return tail.length > 0 ? `${spec.systemPrompt}\n\n${tail}` : spec.systemPrompt;
  }

  return `${systemPrompt}\n\n${spec.systemPrompt}`;
}

function appendModeState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  activeMode: string | undefined,
): void {
  if (!hasText(activeMode)) return;
  if (isEphemeralSession(ctx)) return;
  const latestMode = readActiveModeFromEntry(
    ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === MODE_STATE_ENTRY)
      .at(-1),
  );
  if (latestMode === undefined && activeMode === runtime.data.currentMode) return;
  if (latestMode === activeMode) return;
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

const modeApplyActions = createModeApplyActions({
  runtime,
  ensureRuntime,
  syncErrorUI,
  ensureModesReady,
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

export default function modesExtension(pi: ExtensionAPI): void {
  const registeredModeFlags = new Map<string, string>();
  const { showModePicker, cycleMode, restoreMode, activateMode } = createModeActionHandlers({
    runtime,
    modeStateEntry: MODE_STATE_ENTRY,
    ensureRuntime,
    syncErrorUI,
    notifyConfigError,
    hasText,
    describeModeSpec,
    orderedModeNames,
    getModeSpec,
    applyMode,
    syncFromSelection,
    syncModeTools,
    setStatus,
    appendModeState,
    emitModeChanged,
    getStartupModeSelection: (extensionApi) =>
      getStartupModeSelection(extensionApi, orderedModeNames(runtime.data)),
    notifyStartupModeConflict,
  });

  registerModeFlags(pi, registeredModeFlags, { orderedModeNames, describeModeSpec, hasText });
  const unregisterModeFlagRefresh = subscribeModeFlagRefresh(() => {
    registerModeFlags(pi, registeredModeFlags, { orderedModeNames, describeModeSpec, hasText });
  });
  registerModeCommand(pi, {
    getModeArgumentCompletions,
    showModePicker,
    applyMode,
  });
  registerModeShortcuts(pi, { showModePicker, cycleMode });
  pi.on("before_agent_start", (event) => {
    const activeMode = runtime.activeMode;
    const spec = activeMode === undefined ? undefined : getModeSpec(runtime.data, activeMode);
    const systemPrompt = applyModeSystemPrompt(event.systemPrompt, spec);
    return systemPrompt === undefined ? undefined : { systemPrompt };
  });
  registerModeLifecycleHandlers(pi, {
    resetRuntimeState: () => {
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
  const unregisterModeEventHandlers = registerModeEventHandlers(pi, {
    modeActivateEvent: MODE_ACTIVATE_EVENT,
    modeSelectionApplyEvent: MODE_SELECTION_APPLY_EVENT,
    parseModeActivateEvent,
    activateMode,
    parseModeSelectionApplyEvent,
    applySelection,
  });

  pi.on("session_shutdown", () => {
    unregisterModeFlagRefresh();
    unregisterModeEventHandlers();
  });
}
