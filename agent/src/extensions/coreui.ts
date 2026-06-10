import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ThemeColorSchema, type ThemeColor } from "../mode-utils.js";
import { applyGitStateUpdatedEvent, GIT_STATE_UPDATED_EVENT } from "./git-state.js";
import { isStaleSessionReplacementContextError } from "./session-replacement.js";
import { OPENUSAGE_UPDATED_EVENT } from "./openusage/types.js";
import { parseUpdatedEvent } from "./openusage/events.js";
import { renderStatus as renderOpenUsageStatus } from "./openusage/status.js";
import {
  parseWorkflowProgressEvent,
  WORKFLOW_PROGRESS_EVENT,
} from "./dynamic-workflows/status-events.js";
import { clearContextPruneLastResult, getContextPruneAPI } from "./context-prune/public-api.js";
import { OPENAI_BETTER_UPDATED_EVENT } from "./openai-better/types.js";
import {
  applyCoreUIWorkingIndicator,
  bindCoreUI,
  calculateTotalCost,
  createAiAutocompleteBackend,
  createCorePromptEditorFactory,
  createCoreUIState,
  createProjectInfoRefresher,
  pickRandomWhimsical,
  registerCoreUIToolOverrides,
  registerTPSExtension,
  startCoreUIWorkingMessageShimmer,
  stopCoreUIWorkingMessageShimmer,
} from "./coreui/index.js";
import { registerGitHubReferenceAutocomplete } from "./coreui/github-reference-autocomplete.js";
import { getAiAutocompleteSettings } from "./coreui/ai-autocomplete-settings.js";
import {
  saveAiAutocompleteSettings,
  type AiAutocompleteSettings,
} from "./coreui/ai-autocomplete-settings.js";
import { getLatestAssistantSummary } from "./session-launch-utils.js";

const ModeChangedEventSchema = Type.Object({
  mode: Type.Optional(Type.String()),
  spec: Type.Optional(
    Type.Object({
      color: Type.Optional(Type.String()),
    }),
  ),
});

type ModeChangedEventData = Static<typeof ModeChangedEventSchema>;

const AI_AUTOCOMPLETE_SHORTCUT = Key.ctrl(Key.period);
const AI_AUTOCOMPLETE_NEXT_SHORTCUT = Key.ctrl(Key.comma);
const AI_AUTOCOMPLETE_PREVIOUS_SHORTCUT = Key.ctrlShift(Key.comma);
const AI_AUTOCOMPLETE_PREVIOUS_ALTERNATE_SHORTCUT = Key.ctrl(Key.lessthan);

function readCoreUIIdleState(ctx: ExtensionContext): boolean {
  try {
    return ctx.isIdle();
  } catch (error) {
    if (isStaleSessionReplacementContextError(error)) {
      return false;
    }
    throw error;
  }
}

function parseModeChangedEvent(data: unknown): ModeChangedEventData | undefined {
  if (!Value.Check(ModeChangedEventSchema, data)) {
    return undefined;
  }

  return Value.Parse(ModeChangedEventSchema, data);
}

function parseThemeColor(value: unknown): ThemeColor | undefined {
  if (!Value.Check(ThemeColorSchema, value)) {
    return undefined;
  }

  return Value.Parse(ThemeColorSchema, value);
}

function ignoreStaleSessionReplacementError(error: unknown): void {
  if (!isStaleSessionReplacementContextError(error)) {
    throw error;
  }
}

function requestRenderSafely(requestRender: (() => void) | undefined): void {
  if (!requestRender) {
    return;
  }

  try {
    requestRender();
  } catch (error) {
    ignoreStaleSessionReplacementError(error);
  }
}

function getLatestAssistantSummarySafely(ctx: ExtensionContext): string | undefined {
  try {
    return getLatestAssistantSummary(ctx);
  } catch (error) {
    ignoreStaleSessionReplacementError(error);
    return undefined;
  }
}

function registerSessionStartHandler(input: {
  pi: ExtensionAPI;
  state: ReturnType<typeof createCoreUIState>;
  aiAutocompleteSettings: AiAutocompleteSettings;
  setAutocompleteContext: (ctx: ExtensionContext) => void;
  getAutocompleteContext: () => ExtensionContext | undefined;
  setTriggerAutocomplete: (trigger: (() => void) | undefined) => void;
  setCycleAutocompleteSuggestion: (cycle: ((direction: 1 | -1) => void) | undefined) => void;
  setCancelAutocomplete: (cancel: (() => void) | undefined) => void;
  ensureToolOverridesRegistered: (tools: ReturnType<ExtensionAPI["getActiveTools"]>) => void;
  refreshUsageMetrics: (ctx: ExtensionContext) => void;
  refreshProjectInfo: (ctx: ExtensionContext, force: boolean) => void;
  setRequestRender: (requestRender: (() => void) | undefined) => void;
}): void {
  input.pi.on("session_start", (_event, ctx) => {
    try {
      input.setAutocompleteContext(ctx);
      input.ensureToolOverridesRegistered(input.pi.getActiveTools());
      input.state.cwd = ctx.cwd;
      if (ctx.hasUI) {
        applyCoreUIWorkingIndicator(ctx);
        const theme = ctx.ui.theme;
        ctx.ui.setEditorComponent(
          createCorePromptEditorFactory(
            () => theme,
            () => readCoreUIIdleState(ctx),
            {
              backend: createAiAutocompleteBackend(
                input.getAutocompleteContext,
                input.aiAutocompleteSettings,
              ),
              settings: input.aiAutocompleteSettings,
              cwd: ctx.cwd,
              getAssistantSummary: () => {
                const activeContext = input.getAutocompleteContext();
                return activeContext ? getLatestAssistantSummarySafely(activeContext) : undefined;
              },
              setTriggerAutocomplete: input.setTriggerAutocomplete,
              setCycleAutocompleteSuggestion: input.setCycleAutocompleteSuggestion,
              setCancelAutocomplete: input.setCancelAutocomplete,
            },
          ),
        );
        registerGitHubReferenceAutocomplete(input.pi, ctx);
        bindCoreUI(ctx, input.pi, input.state, (nextRequestRender) => {
          input.setRequestRender(nextRequestRender);
        });
      }
      input.refreshUsageMetrics(ctx);
      input.refreshProjectInfo(ctx, true);
    } catch (error) {
      ignoreStaleSessionReplacementError(error);
    }
  });
}

function registerAutocompleteCommand(
  pi: ExtensionAPI,
  settings: AiAutocompleteSettings,
  triggerAutocomplete: () => void,
  cancelAutocomplete: () => void,
  requestRender: () => void,
): void {
  const persistSettings = async (): Promise<void> => {
    await saveAiAutocompleteSettings(settings);
    requestRender();
  };

  const tryPersistSettings = async (ctx: ExtensionContext): Promise<boolean> => {
    try {
      await persistSettings();
      return true;
    } catch (error) {
      ctx.ui.notify(`Failed to save autocomplete settings: ${String(error)}`, "error");
      return false;
    }
  };
  const updateSettings = async (
    ctx: ExtensionContext,
    update: () => void,
    options?: { cancelPendingAutocomplete?: boolean },
  ): Promise<boolean> => {
    const previous = { ...settings, models: [...settings.models] };
    update();
    if (options?.cancelPendingAutocomplete === true) {
      cancelAutocomplete();
    }
    if (await tryPersistSettings(ctx)) return true;
    Object.assign(settings, previous);
    return false;
  };

  pi.registerCommand("autocomplete", {
    description: "Configure AI autocomplete. Usage: /autocomplete status|on|off|eager|lazy",
    getArgumentCompletions(prefix) {
      const trimmed = prefix.trim();
      return [
        { value: "status", label: "status", description: "Show AI autocomplete status" },
        { value: "on", label: "on", description: "Enable AI autocomplete" },
        { value: "off", label: "off", description: "Disable AI autocomplete" },
        { value: "eager", label: "eager", description: "Enable and trigger while typing" },
        {
          value: "lazy",
          label: "lazy",
          description: `Enable and trigger only with ${AI_AUTOCOMPLETE_SHORTCUT}`,
        },
        { value: "trigger", label: "trigger", description: "Trigger AI autocomplete now" },
      ].filter((item) => item.value.startsWith(trimmed));
    },
    async handler(args, ctx) {
      const command = args.trim();
      if (command === "on") {
        if (
          !(await updateSettings(ctx, () => {
            settings.enabled = true;
          }))
        )
          return;
        ctx.ui.notify("AI autocomplete enabled.", "info");
        return;
      }
      if (command === "off") {
        if (
          !(await updateSettings(
            ctx,
            () => {
              settings.enabled = false;
            },
            { cancelPendingAutocomplete: true },
          ))
        )
          return;
        ctx.ui.notify("AI autocomplete disabled.", "info");
        return;
      }
      if (command === "eager") {
        if (
          !(await updateSettings(ctx, () => {
            settings.enabled = true;
            settings.mode = "eager";
          }))
        )
          return;
        ctx.ui.notify("AI autocomplete set to eager mode.", "info");
        return;
      }
      if (command === "lazy") {
        if (
          !(await updateSettings(
            ctx,
            () => {
              settings.enabled = true;
              settings.mode = "lazy";
            },
            { cancelPendingAutocomplete: true },
          ))
        )
          return;
        ctx.ui.notify(`AI autocomplete set to lazy mode (${AI_AUTOCOMPLETE_SHORTCUT}).`, "info");
        return;
      }
      if (command === "status" || command === "") {
        ctx.ui.notify(
          `AI autocomplete: ${settings.enabled ? "enabled" : "disabled"}, mode: ${settings.mode}, trigger: ${AI_AUTOCOMPLETE_SHORTCUT}`,
          "info",
        );
        return;
      }
      if (command === "trigger") {
        triggerAutocomplete();
        return;
      }

      ctx.ui.notify("Usage: /autocomplete status|on|off|eager|lazy|trigger", "warning");
    },
  });
}

function registerCoreUIHandlers(input: {
  pi: ExtensionAPI;
  ensureToolOverridesRegistered: (tools: ReturnType<ExtensionAPI["getActiveTools"]>) => void;
  refreshAll: (ctx: ExtensionContext) => void;
  getRequestRender: () => (() => void) | undefined;
  clearSubscriptions: () => void;
  setRequestRender: (requestRender: (() => void) | undefined) => void;
}): void {
  let shimmerInterval: ReturnType<typeof setInterval> | undefined;

  input.pi.on("turn_start", (_event, ctx) => {
    try {
      stopCoreUIWorkingMessageShimmer(shimmerInterval, ctx);
      shimmerInterval = undefined;
      shimmerInterval = startCoreUIWorkingMessageShimmer(ctx, pickRandomWhimsical());
    } catch (error) {
      ignoreStaleSessionReplacementError(error);
    }
  });

  input.pi.on("turn_end", (_event, ctx) => {
    try {
      input.refreshAll(ctx);
      stopCoreUIWorkingMessageShimmer(shimmerInterval, ctx);
      shimmerInterval = undefined;
    } catch (error) {
      ignoreStaleSessionReplacementError(error);
    }
  });

  input.pi.on("session_tree", (_event, ctx) => {
    try {
      input.ensureToolOverridesRegistered(input.pi.getActiveTools());
      input.refreshAll(ctx);
    } catch (error) {
      ignoreStaleSessionReplacementError(error);
    }
  });

  input.pi.on("model_select", () => {
    try {
      input.ensureToolOverridesRegistered(input.pi.getActiveTools());
      requestRenderSafely(input.getRequestRender());
    } catch (error) {
      ignoreStaleSessionReplacementError(error);
    }
  });

  input.pi.on("before_agent_start", () => {
    try {
      input.ensureToolOverridesRegistered(input.pi.getActiveTools());
    } catch (error) {
      ignoreStaleSessionReplacementError(error);
    }
  });

  input.pi.on("session_shutdown", () => {
    if (shimmerInterval !== undefined) {
      clearInterval(shimmerInterval);
      shimmerInterval = undefined;
    }
    input.clearSubscriptions();
    input.setRequestRender(undefined);
  });
}

function createCoreUISubscriptions(input: {
  pi: ExtensionAPI;
  state: ReturnType<typeof createCoreUIState>;
  getRequestRender: () => (() => void) | undefined;
}): () => void {
  const unsubscribeOpenUsageEvents = input.pi.events.on(OPENUSAGE_UPDATED_EVENT, (data) => {
    const event = parseUpdatedEvent(data);
    if (event?.active === true) {
      input.state.openUsageStatus = event.snapshot
        ? renderOpenUsageStatus(event.snapshot)
        : undefined;
    }
    requestRenderSafely(input.getRequestRender());
  });

  const unsubscribeGitStateEvents = input.pi.events.on(GIT_STATE_UPDATED_EVENT, (data) => {
    try {
      applyGitStateUpdatedEvent(data);
      requestRenderSafely(input.getRequestRender());
    } catch (error) {
      ignoreStaleSessionReplacementError(error);
    }
  });

  const unsubscribeModeEvents = input.pi.events.on("modes:changed", (data) => {
    try {
      const event = parseModeChangedEvent(data);
      input.state.activeMode = event?.mode ?? "custom";
      input.state.activeModeColor = parseThemeColor(event?.spec?.color);
      requestRenderSafely(input.getRequestRender());
    } catch (error) {
      ignoreStaleSessionReplacementError(error);
    }
  });

  const unsubscribeOpenAIBetterEvents = input.pi.events.on(OPENAI_BETTER_UPDATED_EVENT, () => {
    requestRenderSafely(input.getRequestRender());
  });

  const unsubscribeWorkflowProgressEvents = input.pi.events.on(WORKFLOW_PROGRESS_EVENT, (data) => {
    const event = parseWorkflowProgressEvent(data);
    if (event?.status === "active") input.state.workflowStatus = event;
    else if (event?.status === "clear") input.state.workflowStatus = undefined;
    requestRenderSafely(input.getRequestRender());
  });

  return () => {
    unsubscribeOpenUsageEvents();
    unsubscribeGitStateEvents();
    unsubscribeModeEvents();
    unsubscribeOpenAIBetterEvents();
    unsubscribeWorkflowProgressEvents();
  };
}

function createCoreUIBindings(pi: ExtensionAPI): {
  state: ReturnType<typeof createCoreUIState>;
  refreshAll: (ctx: ExtensionContext) => void;
  refreshUsageMetrics: (ctx: ExtensionContext) => void;
  refreshProjectInfo: (ctx: ExtensionContext, force: boolean) => void;
  getRequestRender: () => (() => void) | undefined;
  setRequestRender: (requestRender: (() => void) | undefined) => void;
  clearSubscriptions: () => void;
} {
  const state = createCoreUIState();
  let requestRender: (() => void) | undefined;

  const refreshProjectInfo = createProjectInfoRefresher(state, () => {
    requestRenderSafely(requestRender);
  });

  const refreshUsageMetrics = (ctx: ExtensionContext): void => {
    state.totalCost = calculateTotalCost(ctx);
    requestRenderSafely(requestRender);
  };

  const refreshAll = (ctx: ExtensionContext): void => {
    refreshUsageMetrics(ctx);
    refreshProjectInfo(ctx, true);
  };
  let unsubscribeContextPrune: (() => void) | undefined;
  const clearCoreUISubscriptions = createCoreUISubscriptions({
    pi,
    state,
    getRequestRender: () => requestRender,
  });

  pi.on("agent_start", () => {
    clearContextPruneLastResult();
  });

  pi.on("session_start", (_event, ctx) => {
    unsubscribeContextPrune?.();
    const api = getContextPruneAPI(ctx);
    unsubscribeContextPrune = api?.onPrune(() => {
      refreshUsageMetrics(ctx);
    });
  });

  const clearSubscriptions = (): void => {
    unsubscribeContextPrune?.();
    unsubscribeContextPrune = undefined;
    clearCoreUISubscriptions();
  };

  return {
    state,
    refreshAll,
    refreshUsageMetrics,
    refreshProjectInfo,
    getRequestRender: () => requestRender,
    setRequestRender: (nextRequestRender) => {
      requestRender = nextRequestRender;
    },
    clearSubscriptions,
  };
}

export default function coreUIExtension(pi: ExtensionAPI) {
  const ensureToolOverridesRegistered = registerCoreUIToolOverrides(pi);
  const bindings = createCoreUIBindings(pi);
  const aiAutocompleteSettings = getAiAutocompleteSettings();
  let autocompleteContext: ExtensionContext | undefined;
  let triggerAutocomplete: (() => void) | undefined;
  let cycleAutocompleteSuggestion: ((direction: 1 | -1) => void) | undefined;
  let cancelAutocomplete: (() => void) | undefined;

  const triggerCurrentAutocomplete = (): void => {
    triggerAutocomplete?.();
  };
  const cancelCurrentAutocomplete = (): void => {
    cancelAutocomplete?.();
  };
  const cycleCurrentAutocompleteSuggestion = (direction: 1 | -1): void => {
    cycleAutocompleteSuggestion?.(direction);
  };

  pi.registerShortcut(AI_AUTOCOMPLETE_SHORTCUT, {
    description: "Trigger AI autocomplete",
    handler: () => {
      triggerCurrentAutocomplete();
    },
  });

  pi.registerShortcut(AI_AUTOCOMPLETE_NEXT_SHORTCUT, {
    description: "Cycle to next AI autocomplete suggestion",
    handler: () => {
      cycleCurrentAutocompleteSuggestion(1);
    },
  });

  pi.registerShortcut(AI_AUTOCOMPLETE_PREVIOUS_SHORTCUT, {
    description: "Cycle to previous AI autocomplete suggestion",
    handler: () => {
      cycleCurrentAutocompleteSuggestion(-1);
    },
  });

  pi.registerShortcut(AI_AUTOCOMPLETE_PREVIOUS_ALTERNATE_SHORTCUT, {
    description: "Cycle to previous AI autocomplete suggestion",
    handler: () => {
      cycleCurrentAutocompleteSuggestion(-1);
    },
  });

  registerAutocompleteCommand(
    pi,
    aiAutocompleteSettings,
    triggerCurrentAutocomplete,
    cancelCurrentAutocomplete,
    () => {
      requestRenderSafely(bindings.getRequestRender());
    },
  );

  registerSessionStartHandler({
    pi,
    state: bindings.state,
    aiAutocompleteSettings,
    setAutocompleteContext: (ctx) => {
      autocompleteContext = ctx;
    },
    getAutocompleteContext: () => autocompleteContext,
    setTriggerAutocomplete: (trigger) => {
      triggerAutocomplete = trigger;
    },
    setCycleAutocompleteSuggestion: (cycle) => {
      cycleAutocompleteSuggestion = cycle;
    },
    setCancelAutocomplete: (cancel) => {
      cancelAutocomplete = cancel;
    },
    ensureToolOverridesRegistered,
    refreshUsageMetrics: bindings.refreshUsageMetrics,
    refreshProjectInfo: bindings.refreshProjectInfo,
    setRequestRender: bindings.setRequestRender,
  });

  registerCoreUIHandlers({
    pi,
    ensureToolOverridesRegistered,
    refreshAll: bindings.refreshAll,
    getRequestRender: bindings.getRequestRender,
    clearSubscriptions: bindings.clearSubscriptions,
    setRequestRender: bindings.setRequestRender,
  });

  registerTPSExtension(pi, bindings.state, () => {
    requestRenderSafely(bindings.getRequestRender());
  });
}
