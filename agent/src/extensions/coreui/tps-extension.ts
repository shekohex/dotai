import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { CoreUIState } from "./types.js";
import {
  formatCompactCount,
  resolveAssistantOutputTokens,
  summarizeAssistantUsage,
} from "./tps-metrics.js";
import {
  appendTPSEntry,
  formatTPSNotification,
  getLatestTPSSessionEntry,
  getTPSCommandCompletions,
  restoreTPSState,
  setPersistedTPSVisibility,
  setTPSState,
  updateTPSElapsedInState,
  type TPSRunState,
} from "./tps-state.js";

type RuntimeState = {
  run: TPSRunState | null;
  sessionSamples: number[];
  persistedElapsedMs: number;
};

function handleTPSCommand(
  pi: ExtensionAPI,
  state: CoreUIState,
  requestRender: () => void,
  args: string,
  ctx: ExtensionCommandContext,
): void {
  const action = args.trim().toLowerCase();
  if (!action || action === "status") {
    const latestEntry = getLatestTPSSessionEntry(ctx.sessionManager.getBranch());
    const status = `TPS ${state.tpsVisible ? "on" : "off"}`;
    ctx.ui.notify(
      latestEntry ? `${status}. ${formatTPSNotification(latestEntry)}` : status,
      "info",
    );
    return;
  }
  if (action !== "on" && action !== "off") {
    ctx.ui.notify("Usage: /tps <on|off>", "warning");
    return;
  }
  const visible = action === "on";
  const changed = setPersistedTPSVisibility(pi, state, visible);
  if (changed) {
    requestRender();
  }
  ctx.ui.notify(`TPS ${visible ? "enabled" : "hidden"}`, "info");
}

function updateTPSForRun(
  state: CoreUIState,
  requestRender: () => void,
  runtime: RuntimeState,
  outputTokens: number,
): void {
  const run = runtime.run;
  if (!run) {
    return;
  }
  const result = setTPSState(state, runtime.sessionSamples, run, outputTokens);
  const elapsedChanged = updateTPSElapsedInState(state, runtime.persistedElapsedMs, run);
  runtime.sessionSamples = result.nextSamples;
  if (result.changed || elapsedChanged) {
    requestRender();
  }
}

function notifyTPSSummary(
  ctx: ExtensionContext,
  usage: ReturnType<typeof summarizeAssistantUsage>,
  elapsedMs: number,
): void {
  const elapsedSeconds = elapsedMs / 1000;
  const tokensPerSecond = usage.output / elapsedSeconds;
  const message = `TPS ${tokensPerSecond.toFixed(1)} tok/s. out ${formatCompactCount(usage.output)}, in ${formatCompactCount(usage.input)}, cache r/w ${formatCompactCount(usage.cacheRead)}/${formatCompactCount(usage.cacheWrite)}, total ${formatCompactCount(usage.totalTokens)}, ${elapsedSeconds.toFixed(1)}s`;
  ctx.ui.notify(message, "info");
}

export default function registerTPSExtension(
  pi: ExtensionAPI,
  state: CoreUIState,
  requestRender: () => void,
) {
  const runtime: RuntimeState = { run: null, sessionSamples: [], persistedElapsedMs: 0 };
  registerTPSCommandHandler(pi, state, requestRender);
  registerTPSEventHandlers(pi, state, requestRender, runtime);
}

function registerTPSCommandHandler(
  pi: ExtensionAPI,
  state: CoreUIState,
  requestRender: () => void,
): void {
  pi.registerCommand("tps", {
    description: "Toggle TPS footer display: /tps on, /tps off",
    getArgumentCompletions: (prefix) => getTPSCommandCompletions(prefix),
    handler: (args, ctx) => {
      handleTPSCommand(pi, state, requestRender, args, ctx);
      return Promise.resolve();
    },
  });
}

function registerTPSEventHandlers(
  pi: ExtensionAPI,
  state: CoreUIState,
  requestRender: () => void,
  runtime: RuntimeState,
): void {
  registerSessionLifecycleEvents(pi, state, requestRender, runtime);
  registerMessageEvents(pi, state, requestRender, runtime);
  registerTurnAndAgentEndEvents(pi, state, requestRender, runtime);
}

function registerSessionLifecycleEvents(
  pi: ExtensionAPI,
  state: CoreUIState,
  requestRender: () => void,
  runtime: RuntimeState,
): void {
  pi.on("session_start", (_event, ctx) => {
    const restored = restoreTPSState(ctx.sessionManager.getBranch());
    state.tps = restored.tps;
    state.tpsVisible = restored.tpsVisible;
    state.tpsElapsedMs = restored.tpsElapsedMs;
    runtime.persistedElapsedMs = restored.tpsElapsedMs;
    runtime.sessionSamples = [];
    requestRender();
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    runtime.run = { startedAtMs: Date.now(), completedOutputTokens: 0, currentOutputTokens: 0 };
  });
}

function registerMessageEvents(
  pi: ExtensionAPI,
  state: CoreUIState,
  requestRender: () => void,
  runtime: RuntimeState,
): void {
  pi.on("message_update", (event: { message: AgentMessage }, ctx) => {
    if (!ctx.hasUI || !runtime.run || event.message.role !== "assistant") return;
    runtime.run.currentOutputTokens = resolveAssistantOutputTokens(event.message);
    updateTPSForRun(
      state,
      requestRender,
      runtime,
      runtime.run.completedOutputTokens + runtime.run.currentOutputTokens,
    );
  });

  pi.on("message_end", (event: { message: AgentMessage }, ctx) => {
    if (!ctx.hasUI || !runtime.run || event.message.role !== "assistant") return;
    runtime.run.completedOutputTokens += resolveAssistantOutputTokens(event.message);
    runtime.run.currentOutputTokens = 0;
    updateTPSForRun(state, requestRender, runtime, runtime.run.completedOutputTokens);
  });
}

function registerTurnAndAgentEndEvents(
  pi: ExtensionAPI,
  state: CoreUIState,
  requestRender: () => void,
  runtime: RuntimeState,
): void {
  pi.on("turn_end", (_event, ctx) => {
    if (!ctx.hasUI || !runtime.run) return;
    updateTPSForRun(
      state,
      requestRender,
      runtime,
      runtime.run.completedOutputTokens + runtime.run.currentOutputTokens,
    );
  });

  pi.on("agent_end", (event: { messages: AgentMessage[] }, ctx) => {
    if (!ctx.hasUI || !runtime.run) return;
    const elapsedMs = Date.now() - runtime.run.startedAtMs;
    const usage = summarizeAssistantUsage(event.messages);
    const outputTokens = Math.max(
      usage.output,
      runtime.run.completedOutputTokens + runtime.run.currentOutputTokens,
    );
    const result = setTPSState(state, runtime.sessionSamples, runtime.run, outputTokens);
    runtime.sessionSamples = result.nextSamples;
    const finalStats = state.tps;
    if (elapsedMs > 0) {
      runtime.persistedElapsedMs += elapsedMs;
    }
    const elapsedChanged = updateTPSElapsedInState(state, runtime.persistedElapsedMs, null);
    runtime.run = null;

    if (result.changed || elapsedChanged) {
      requestRender();
    }
    if (elapsedMs > 0 && usage.output > 0 && finalStats) {
      appendTPSEntry(pi, finalStats, usage, elapsedMs);
    }
    if (state.tpsVisible && elapsedMs > 0 && usage.output > 0) {
      notifyTPSSummary(ctx, usage, elapsedMs);
    }
  });
}
