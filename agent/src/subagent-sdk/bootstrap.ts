import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  activateAutoExitTimeoutMode,
  consumeParentInjectedInputMarker,
  isAutoExitTimeoutModeActive,
} from "./persistence.js";
import { readChildState } from "./launch.js";
import type { ChildBootstrapState } from "./types.js";

const bootstrapInstalledSymbol = Symbol.for("@shekohex/agent/subagent-sdk/bootstrap-installed");

type BootstrapAwareExtensionApi = ExtensionAPI & {
  [bootstrapInstalledSymbol]?: boolean;
};

function normalizeSingleLine(value: string): string {
  let normalized = "";
  let previousWasWhitespace = false;

  for (const char of value) {
    const codePoint = char.codePointAt(0);
    const isControl = codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    const isWhitespace = isControl || /\s/.test(char);
    if (isWhitespace) {
      if (!previousWasWhitespace) {
        normalized += " ";
        previousWasWhitespace = true;
      }
      continue;
    }

    normalized += char;
    previousWasWhitespace = false;
  }

  return normalized.trim();
}

function formatChildSessionDisplayName(name: string, prompt: string): string {
  const normalizedPrompt = normalizeSingleLine(prompt);
  return normalizedPrompt ? `[${name}] ${normalizedPrompt}` : `[${name}]`;
}

export function applyChildToolState(
  pi: ExtensionAPI,
  childState: ChildBootstrapState | undefined,
): void {
  if (!childState) {
    return;
  }

  const activeTools = new Set(childState.tools);
  activeTools.delete("subagent");
  pi.setActiveTools(Array.from(activeTools).sort((left, right) => left.localeCompare(right)));
}

export function isChildSession(
  childState: ChildBootstrapState | undefined,
  ctx: ExtensionContext,
): childState is ChildBootstrapState {
  if (!childState) {
    return false;
  }

  return (
    ctx.sessionManager.getSessionId() === childState.sessionId ||
    ctx.sessionManager.getSessionFile() === childState.sessionPath
  );
}

export function installChildBootstrap(pi: ExtensionAPI): void {
  const bootstrapAwarePi = pi as BootstrapAwareExtensionApi;
  if (bootstrapAwarePi[bootstrapInstalledSymbol]) {
    return;
  }

  bootstrapAwarePi[bootstrapInstalledSymbol] = true;

  const childState = readChildState();
  const autoExitEnabled = Boolean(childState?.autoExit);
  let pendingIdleShutdown: ReturnType<typeof setTimeout> | undefined;
  let timeoutModeActive = childState ? isAutoExitTimeoutModeActive(childState.sessionId) : false;

  const cancelIdleShutdown = () => {
    if (!pendingIdleShutdown) {
      return;
    }

    clearTimeout(pendingIdleShutdown);
    pendingIdleShutdown = undefined;
  };

  const scheduleIdleShutdown = (ctx: ExtensionContext, currentChildState: ChildBootstrapState) => {
    cancelIdleShutdown();

    if (!timeoutModeActive) {
      ctx.shutdown();
      return;
    }

    pendingIdleShutdown = setTimeout(() => {
      pendingIdleShutdown = undefined;
      if (!autoExitEnabled || !isChildSession(currentChildState, ctx)) {
        return;
      }

      ctx.shutdown();
    }, currentChildState.autoExitTimeoutMs ?? 30_000);
    pendingIdleShutdown.unref?.();
  };

  pi.on("session_start", async (_event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx)) {
      return;
    }

    timeoutModeActive = isAutoExitTimeoutModeActive(currentChildState.sessionId);

    applyChildToolState(pi, currentChildState);
    pi.setSessionName(
      formatChildSessionDisplayName(currentChildState.name, currentChildState.prompt),
    );

    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.onTerminalInput((data) => {
      if (!autoExitEnabled || !data.trim()) {
        return undefined;
      }

      if (consumeParentInjectedInputMarker(currentChildState.sessionId)) {
        return undefined;
      }

      timeoutModeActive = true;
      activateAutoExitTimeoutMode(currentChildState.sessionId);
      cancelIdleShutdown();
      return undefined;
    });
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx)) {
      return undefined;
    }

    cancelIdleShutdown();
    applyChildToolState(pi, currentChildState);
    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx) || !autoExitEnabled) {
      return;
    }

    scheduleIdleShutdown(ctx, currentChildState);
  });

  pi.on("session_shutdown", async () => {
    cancelIdleShutdown();
  });
}
