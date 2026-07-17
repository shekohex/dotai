import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";

import type { ModeModelCandidate, ModesFile, ModeSpec } from "../../mode-utils.js";
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
  isThinkingLevel,
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
import { applyModeSystemPrompt } from "../../mode-system-prompt.js";
import {
  createModeFailoverRuntime,
  handleModeAssistantMessageEnd,
  restorePrimaryModelForMode,
} from "./failover.js";
import {
  ensureModesReady as ensureModesReadyRuntime,
  ensureRuntime as ensureRuntimeState,
  notifyConfigError as notifyConfigErrorState,
  syncErrorUI as syncErrorUIState,
} from "./runtime.js";
import { isEphemeralSession } from "./session.js";
import type { ModeStartupSelection } from "./startup-selection.js";

export const MODE_STATE_ENTRY = "mode-state";
export const MODE_MODEL_OVERRIDE_ENTRY = "mode-model-override-state";
export const MODE_ACTIVATE_EVENT = "modes:activate";
export const MODE_SELECTION_APPLY_EVENT = "modes:apply-selection";
const MODE_STATUS_KEY = "mode";
const CUSTOM_MODE_LABEL = "custom";

type ModeRuntime = {
  data: ModesFile;
  activeMode: string | undefined;
  applying: boolean;
  needsResyncAfterApply: boolean;
  sessionModelOverrides: Map<string, ModeModelCandidate>;
  internalModelChangeDepth: number;
  lastContext?: ExtensionContext;
  error?: string;
  lastReportedError?: string;
  lastStatusText?: string;
  toolsInitialized: boolean;
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
  toolsInitialized: false,
  sessionModelOverrides: new Map(),
  internalModelChangeDepth: 0,
  error: undefined,
  lastReportedError: undefined,
  lastStatusText: undefined,
};
const failoverRuntime = createModeFailoverRuntime();
failoverRuntime.withInternalModelChange = withInternalModelChange;

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

function getModelAutocompleteEntries(ctx: ExtensionContext): Array<{
  provider: string;
  modelId: string;
}> {
  return getAvailableModels(ctx).map((model) => ({ provider: model.provider, modelId: model.id }));
}

function getModeArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return getModeCommandCompletions(
    argumentPrefix,
    getModeAutocompleteEntries(),
    runtime.lastContext === undefined ? [] : getModelAutocompleteEntries(runtime.lastContext),
  );
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

function withInternalModelChange<T>(action: () => Promise<T>): Promise<T> {
  runtime.internalModelChangeDepth += 1;
  return action().finally(() => {
    runtime.internalModelChangeDepth -= 1;
  });
}

function getEffectiveModeSpec(modeName: string): ModeSpec | undefined {
  const spec = getModeSpec(runtime.data, modeName);
  const override = runtime.sessionModelOverrides.get(modeName);
  if (spec === undefined || override === undefined) return spec;
  return {
    ...spec,
    provider: override.provider,
    modelId: override.modelId,
    thinkingLevel: override.thinkingLevel ?? spec.thinkingLevel,
  };
}

function getAvailableModels(ctx: ExtensionContext): Model<Api>[] {
  return ctx.modelRegistry.getAvailable();
}

function formatModelReference(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function findModelByReference(ctx: ExtensionContext, reference: string): Model<Api> | undefined {
  const slashIndex = reference.indexOf("/");
  if (slashIndex <= 0 || slashIndex === reference.length - 1) return undefined;
  return ctx.modelRegistry.find(reference.slice(0, slashIndex), reference.slice(slashIndex + 1));
}

async function chooseOverrideModel(
  ctx: ExtensionContext,
  modeName: string,
  query: string | undefined,
): Promise<Model<Api> | undefined> {
  const exact = query === undefined ? undefined : findModelByReference(ctx, query);
  if (exact !== undefined) return exact;

  const models = getAvailableModels(ctx);
  const normalizedQuery = query?.toLowerCase().trim() ?? "";
  const candidates = normalizedQuery
    ? fuzzyFilter(models, normalizedQuery, (model) => `${model.id} ${model.provider}`)
    : models;
  if (candidates.length === 0) {
    ctx.ui.notify(`No models match "${query}"`, "warning");
    return undefined;
  }

  const options = candidates.map((model) => formatModelReference(model));
  const selected = await ctx.ui.select(`Override model for mode "${modeName}"`, options);
  if (!hasText(selected)) return undefined;
  return candidates.find((model) => formatModelReference(model) === selected);
}

async function applyModeOverride(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modeName: string,
  modelQuery: string | undefined,
): Promise<boolean> {
  if (!(await ensureModesReady(ctx))) return false;
  const spec = getModeSpec(runtime.data, modeName);
  if (spec === undefined) {
    ctx.ui.notify(`Unknown mode "${modeName}"`, "warning");
    return false;
  }

  const model = await chooseOverrideModel(ctx, modeName, modelQuery);
  if (model === undefined) return false;

  runtime.sessionModelOverrides.set(modeName, {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: spec.thinkingLevel,
  });
  appendModeOverrideState(pi, ctx, modeName, runtime.sessionModelOverrides.get(modeName));
  return applyMode(pi, ctx, modeName, "command");
}

function applyModeCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modeName: string,
): Promise<boolean> {
  if (runtime.sessionModelOverrides.delete(modeName)) {
    appendModeOverrideState(pi, ctx, modeName);
  }
  return applyMode(pi, ctx, modeName, "command");
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

function appendModeOverrideState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modeName: string,
  override?: ModeModelCandidate,
): void {
  if (isEphemeralSession(ctx)) return;
  pi.appendEntry(MODE_MODEL_OVERRIDE_ENTRY, { mode: modeName, override });
}

function readModeOverrideEntry(value: unknown):
  | {
      mode: string;
      override: ModeModelCandidate | undefined;
    }
  | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("data" in value)) {
    return undefined;
  }
  const data = value.data;
  if (data === null || typeof data !== "object" || Array.isArray(data) || !("mode" in data)) {
    return undefined;
  }
  if (typeof data.mode !== "string") return undefined;
  if (!("override" in data) || data.override === undefined) {
    return { mode: data.mode, override: undefined };
  }
  const override = data.override;
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    return undefined;
  }
  if (
    !("provider" in override) ||
    typeof override.provider !== "string" ||
    !("modelId" in override) ||
    typeof override.modelId !== "string"
  ) {
    return undefined;
  }
  const thinkingLevel = "thinkingLevel" in override ? override.thinkingLevel : undefined;
  if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) return undefined;
  return {
    mode: data.mode,
    override: {
      provider: override.provider,
      modelId: override.modelId,
      thinkingLevel,
    },
  };
}

function restoreSessionModeOverrides(ctx: ExtensionContext): void {
  runtime.sessionModelOverrides.clear();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== MODE_MODEL_OVERRIDE_ENTRY) continue;
    const state = readModeOverrideEntry(entry);
    if (state === undefined) continue;
    if (state.override === undefined) {
      runtime.sessionModelOverrides.delete(state.mode);
      continue;
    }
    runtime.sessionModelOverrides.set(state.mode, state.override);
  }
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

function syncRuntimeModeTools(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec: ModeSpec | undefined,
): void {
  syncModeTools(pi, ctx, spec, {
    preserveActiveDeferredTools: runtime.toolsInitialized,
  });
  runtime.toolsInitialized = true;
}

const modeApplyActions = createModeApplyActions({
  runtime,
  ensureRuntime,
  syncErrorUI,
  ensureModesReady,
  getModeSpec: (_data, modeName) => getEffectiveModeSpec(modeName),
  inferActiveMode,
  currentSelection,
  selectionSatisfiesMode,
  hasText,
  hasModelSelection,
  syncModeTools: syncRuntimeModeTools,
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

function registerModesExtension(pi: ExtensionAPI, startupSelection: ModeStartupSelection): void {
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
    syncModeTools: syncRuntimeModeTools,
    setStatus,
    appendModeState,
    emitModeChanged,
    applyStartupModelOverride: (modeName, ctx) => {
      if (!startupSelection.hasExplicitModel || ctx.model === undefined) return;
      runtime.sessionModelOverrides.set(modeName, {
        provider: ctx.model.provider,
        modelId: ctx.model.id,
      });
    },
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
    applyMode: applyModeCommand,
    applyModeOverride,
  });
  registerModeShortcuts(pi, { showModePicker, cycleMode });
  pi.on("before_agent_start", (event) => {
    const activeMode = runtime.activeMode;
    const spec = activeMode === undefined ? undefined : getEffectiveModeSpec(activeMode);
    const systemPrompt = applyModeSystemPrompt(event.systemPrompt, spec);
    return systemPrompt === undefined ? undefined : { systemPrompt };
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    runtime.lastContext = ctx;
    const activeMode = runtime.activeMode;
    const spec = activeMode === undefined ? undefined : getEffectiveModeSpec(activeMode);
    await restorePrimaryModelForMode(pi, ctx, failoverRuntime, activeMode, spec);
  });
  pi.on("message_end", async (event, ctx) => {
    runtime.lastContext = ctx;
    if (event.message.role !== "assistant") return;
    const activeMode = runtime.activeMode;
    const spec = activeMode === undefined ? undefined : getEffectiveModeSpec(activeMode);
    await handleModeAssistantMessageEnd(pi, ctx, failoverRuntime, activeMode, spec, event.message);
  });
  registerModeLifecycleHandlers(pi, {
    resetRuntimeState: () => {
      runtime.activeMode = undefined;
      runtime.toolsInitialized = false;
      runtime.sessionModelOverrides.clear();
      runtime.lastContext = undefined;
    },
    restoreMode: async (extensionApi, ctx) => {
      runtime.lastContext = ctx;
      restoreSessionModeOverrides(ctx);
      await restoreMode(extensionApi, ctx);
    },
    isApplying: () => runtime.applying,
    isInternalModelChange: () => runtime.internalModelChangeDepth > 0,
    clearActiveMode: () => {
      runtime.activeMode = undefined;
    },
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

const defaultModeStartupSelection: ModeStartupSelection = { hasExplicitModel: false };

export function createModesExtension(startupSelection: ModeStartupSelection): ExtensionFactory {
  return (pi) => {
    registerModesExtension(pi, startupSelection);
  };
}

export default createModesExtension(defaultModeStartupSelection);
