import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { OPENUSAGE_UPDATED_EVENT } from "./openusage/types.js";
import { bindCoreUI } from "./coreui/footer.js";
import { createProjectInfoRefresher } from "./coreui/project-info.js";
import { createCoreUIState } from "./coreui/types.js";
import { registerCoreUIToolOverrides } from "./coreui/tools.js";
import { calculateTotalCost } from "./coreui/usage.js";

export default function coreUIExtension(pi: ExtensionAPI) {
  registerCoreUIToolOverrides(pi);

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

  pi.on("session_start", async (_event, ctx) => {
    bindCoreUI(ctx, pi, state, (nextRequestRender) => {
      requestRender = nextRequestRender;
    });
    refreshUsageMetrics(ctx);
    void refreshProjectInfo(ctx, true);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await refreshAll(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await refreshAll(ctx);
  });

  pi.on("model_select", async () => {
    requestRender?.();
  });

  pi.on("session_shutdown", async () => {
    unsubscribeOpenUsageEvents();
    requestRender = undefined;
  });
}
