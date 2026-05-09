import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ThemeColorSchema, type ThemeColor } from "../mode-utils.js";
import { applyGitStateUpdatedEvent, GIT_STATE_UPDATED_EVENT } from "./git-state.js";
import { isStaleSessionReplacementContextError } from "./session-replacement.js";
import { OPENUSAGE_UPDATED_EVENT } from "./openusage/types.js";
import {
  applyCoreUIWorkingIndicator,
  bindCoreUI,
  calculateTotalCost,
  createCorePromptEditorFactory,
  createCoreUIState,
  createProjectInfoRefresher,
  pickRandomWhimsical,
  registerCoreUIToolOverrides,
  registerTPSExtension,
  startCoreUIWorkingMessageShimmer,
  stopCoreUIWorkingMessageShimmer,
} from "./coreui/index.js";

const ModeChangedEventSchema = Type.Object({
  mode: Type.Optional(Type.String()),
  spec: Type.Optional(
    Type.Object({
      color: Type.Optional(Type.String()),
    }),
  ),
});

type ModeChangedEventData = Static<typeof ModeChangedEventSchema>;

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

function registerSessionStartHandler(input: {
  pi: ExtensionAPI;
  state: ReturnType<typeof createCoreUIState>;
  ensureToolOverridesRegistered: (tools: ReturnType<ExtensionAPI["getActiveTools"]>) => void;
  refreshUsageMetrics: (ctx: ExtensionContext) => void;
  refreshProjectInfo: (ctx: ExtensionContext, force: boolean) => void;
  setRequestRender: (requestRender: (() => void) | undefined) => void;
}): void {
  input.pi.on("session_start", (_event, ctx) => {
    try {
      input.ensureToolOverridesRegistered(input.pi.getActiveTools());
      input.state.cwd = ctx.cwd;
      if (ctx.hasUI) {
        applyCoreUIWorkingIndicator(ctx);
        const theme = ctx.ui.theme;
        ctx.ui.setEditorComponent(
          createCorePromptEditorFactory(
            () => theme,
            () => readCoreUIIdleState(ctx),
          ),
        );
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
  const unsubscribeOpenUsageEvents = input.pi.events.on(OPENUSAGE_UPDATED_EVENT, () => {
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

  return () => {
    unsubscribeOpenUsageEvents();
    unsubscribeGitStateEvents();
    unsubscribeModeEvents();
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
  const clearSubscriptions = createCoreUISubscriptions({
    pi,
    state,
    getRequestRender: () => requestRender,
  });

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

  registerSessionStartHandler({
    pi,
    state: bindings.state,
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
