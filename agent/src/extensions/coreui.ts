import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ThemeColorSchema, type ThemeColor } from "../mode-utils.js";
import { getRuntimeCapabilities } from "./runtime-capabilities.js";
import { OPENUSAGE_UPDATED_EVENT } from "./openusage/types.js";
import {
  bindCoreUI,
  calculateTotalCost,
  createCorePromptEditorFactory,
  createCoreUIState,
  createProjectInfoRefresher,
  pickRandomWhimsical,
  registerCoreUIToolOverrides,
  registerTPSExtension,
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

function registerSessionStartHandler(input: {
  pi: ExtensionAPI;
  state: ReturnType<typeof createCoreUIState>;
  ensureToolOverridesRegistered: (tools: ReturnType<ExtensionAPI["getActiveTools"]>) => void;
  refreshUsageMetrics: (ctx: ExtensionContext) => void;
  refreshProjectInfo: (ctx: ExtensionContext, force: boolean) => Promise<void>;
  setRequestRender: (requestRender: (() => void) | undefined) => void;
}): void {
  input.pi.on("session_start", (_event, ctx) => {
    const runtimeCapabilities = getRuntimeCapabilities(ctx);
    input.ensureToolOverridesRegistered(input.pi.getActiveTools());
    input.state.cwd = ctx.cwd;
    if (runtimeCapabilities?.primitives.setEditorComponent !== false) {
      ctx.ui.setEditorComponent(
        createCorePromptEditorFactory(
          () => ctx.ui.theme,
          () => ctx.isIdle(),
        ),
      );
    }
    if (
      runtimeCapabilities?.primitives.setHeader !== false &&
      runtimeCapabilities?.primitives.setFooter !== false
    ) {
      bindCoreUI(ctx, input.pi, input.state, (nextRequestRender) => {
        input.setRequestRender(nextRequestRender);
      });
    }
    input.refreshUsageMetrics(ctx);
    void input.refreshProjectInfo(ctx, true);
  });
}

function registerCoreUIHandlers(input: {
  pi: ExtensionAPI;
  ensureToolOverridesRegistered: (tools: ReturnType<ExtensionAPI["getActiveTools"]>) => void;
  refreshAll: (ctx: ExtensionContext) => Promise<void>;
  getRequestRender: () => (() => void) | undefined;
  clearSubscriptions: () => void;
  setRequestRender: (requestRender: (() => void) | undefined) => void;
}): void {
  input.pi.on("turn_start", (_event, ctx) => {
    ctx.ui.setWorkingMessage(pickRandomWhimsical());
  });

  input.pi.on("turn_end", async (_event, ctx) => {
    await input.refreshAll(ctx);
    ctx.ui.setWorkingMessage();
  });

  input.pi.on("session_tree", async (_event, ctx) => {
    input.ensureToolOverridesRegistered(input.pi.getActiveTools());
    await input.refreshAll(ctx);
  });

  input.pi.on("model_select", () => {
    input.ensureToolOverridesRegistered(input.pi.getActiveTools());
    input.getRequestRender()?.();
  });

  input.pi.on("before_agent_start", () => {
    input.ensureToolOverridesRegistered(input.pi.getActiveTools());
  });

  input.pi.on("session_shutdown", () => {
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
    input.getRequestRender()?.();
  });

  const unsubscribeModeEvents = input.pi.events.on("modes:changed", (data) => {
    const event = parseModeChangedEvent(data);
    input.state.activeMode = event?.mode ?? "custom";
    input.state.activeModeColor = parseThemeColor(event?.spec?.color);
    input.getRequestRender()?.();
  });

  return () => {
    unsubscribeOpenUsageEvents();
    unsubscribeModeEvents();
  };
}

function createCoreUIBindings(pi: ExtensionAPI): {
  state: ReturnType<typeof createCoreUIState>;
  refreshAll: (ctx: ExtensionContext) => Promise<void>;
  refreshUsageMetrics: (ctx: ExtensionContext) => void;
  refreshProjectInfo: (ctx: ExtensionContext, force: boolean) => Promise<void>;
  getRequestRender: () => (() => void) | undefined;
  setRequestRender: (requestRender: (() => void) | undefined) => void;
  clearSubscriptions: () => void;
} {
  const state = createCoreUIState();
  let requestRender: (() => void) | undefined;

  const refreshProjectInfo = createProjectInfoRefresher(pi, state, () => {
    requestRender?.();
  });

  const refreshUsageMetrics = (ctx: ExtensionContext): void => {
    state.totalCost = calculateTotalCost(ctx);
    requestRender?.();
  };

  const refreshAll = async (ctx: ExtensionContext): Promise<void> => {
    refreshUsageMetrics(ctx);
    await refreshProjectInfo(ctx, true);
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
    bindings.getRequestRender()?.();
  });
}
