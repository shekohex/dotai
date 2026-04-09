import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import { OPENUSAGE_UPDATED_EVENT } from "./openusage/types.js";
import { bindCoreUI } from "./coreui/footer.js";
import { createCorePromptEditorFactory } from "./coreui/editor.js";
import { createProjectInfoRefresher } from "./coreui/project-info.js";
import { createCoreUIState } from "./coreui/types.js";
import { registerCoreUIToolOverrides } from "./coreui/tools.js";
import { calculateTotalCost } from "./coreui/usage.js";
import { pickRandomWhimsical } from "./coreui/whimsical.js";

export default function coreUIExtension(pi: ExtensionAPI) {
  const ensureToolOverridesRegistered = registerCoreUIToolOverrides(pi);

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

  const unsubscribeOpenUsageEvents = pi.events.on(OPENUSAGE_UPDATED_EVENT, () => {
    requestRender?.();
  });

  const unsubscribeModeEvents = pi.events.on("modes:changed", (data) => {
    const event = data as { mode?: string; spec?: { color?: ThemeColor } };
    state.activeMode = event.mode ?? "custom";
    state.activeModeColor = event.spec?.color;
    requestRender?.();
  });

  pi.on("session_start", async (_event, ctx) => {
    ensureToolOverridesRegistered(pi.getActiveTools());
    ctx.ui.setEditorComponent(
      createCorePromptEditorFactory(() => ctx.ui.theme, () => ctx.isIdle()),
    );
    bindCoreUI(ctx, pi, state, (nextRequestRender) => {
      requestRender = nextRequestRender;
    });
    refreshUsageMetrics(ctx);
    void refreshProjectInfo(ctx, true);
  });

  pi.on("turn_start", async (_event, ctx) => {
    ctx.ui.setWorkingMessage(pickRandomWhimsical());
  });

  pi.on("turn_end", async (_event, ctx) => {
    await refreshAll(ctx);
    ctx.ui.setWorkingMessage(); // Reset for next time
  });

  pi.on("session_tree", async (_event, ctx) => {
    ensureToolOverridesRegistered(pi.getActiveTools());
    await refreshAll(ctx);
  });

  pi.on("model_select", async () => {
    ensureToolOverridesRegistered(pi.getActiveTools());
    requestRender?.();
  });

  pi.on("before_agent_start", async () => {
    ensureToolOverridesRegistered(pi.getActiveTools());
    return undefined;
  });

  pi.on("session_shutdown", async () => {
    unsubscribeOpenUsageEvents();
    unsubscribeModeEvents();
    requestRender = undefined;
  });
}
