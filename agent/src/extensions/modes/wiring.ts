import { Key } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeActivateEvent, ModeSelectionApplyEvent } from "./events.js";

function runModeActivateHandler(
  pi: ExtensionAPI,
  deps: {
    activateMode: (
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      event: ModeActivateEvent,
    ) => Promise<void>;
  },
  event: ModeActivateEvent,
): void {
  deps
    .activateMode(pi, event.ctx, event)
    .then(() => {
      event.done?.resolve();
    })
    .catch((error: unknown) => {
      event.done?.reject(error);
    });
}

function runModeSelectionApplyHandler(
  pi: ExtensionAPI,
  deps: {
    applySelection: (
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      event: ModeSelectionApplyEvent,
    ) => Promise<void>;
  },
  event: ModeSelectionApplyEvent,
): void {
  deps
    .applySelection(pi, event.ctx, event)
    .then(() => {
      event.done?.resolve();
    })
    .catch((error: unknown) => {
      event.done?.reject(error);
    });
}

export function registerModeCommand(
  pi: ExtensionAPI,
  deps: {
    getModeArgumentCompletions: (prefix: string) => AutocompleteItem[] | null;
    showModePicker: (pi: ExtensionAPI, ctx: ExtensionContext) => Promise<void>;
    applyMode: (pi: ExtensionAPI, ctx: ExtensionContext, modeName: string) => Promise<boolean>;
    applyModeOverride: (
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      modeName: string,
      modelQuery: string | undefined,
    ) => Promise<boolean>;
  },
): void {
  pi.registerCommand("mode", {
    description: "Select prompt modes: /mode, /mode <name>, /mode <name> --override [model]",
    getArgumentCompletions: (prefix) => deps.getModeArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const tokens = args
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (tokens.length === 0) {
        await deps.showModePicker(pi, ctx);
        return;
      }

      if (tokens[1] === "--override") {
        await deps.applyModeOverride(pi, ctx, tokens[0], tokens[2]);
        return;
      }

      await deps.applyMode(pi, ctx, tokens[0]);
    },
  });
}

export function registerModeShortcuts(
  pi: ExtensionAPI,
  deps: {
    showModePicker: (pi: ExtensionAPI, ctx: ExtensionContext) => Promise<void>;
    cycleMode: (pi: ExtensionAPI, ctx: ExtensionContext) => Promise<void>;
  },
): void {
  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Select prompt mode",
    handler: async (ctx) => {
      await deps.showModePicker(pi, ctx);
    },
  });

  pi.registerShortcut(Key.ctrlAlt("m"), {
    description: "Cycle prompt mode",
    handler: async (ctx) => {
      await deps.cycleMode(pi, ctx);
    },
  });
}

export function registerModeLifecycleHandlers(
  pi: ExtensionAPI,
  deps: {
    resetRuntimeState: () => void;
    restoreMode: (pi: ExtensionAPI, ctx: ExtensionContext) => Promise<void>;
    isApplying: () => boolean;
    isInternalModelChange: () => boolean;
    clearActiveMode: () => void;
    markNeedsResyncAfterApply: () => void;
    syncFromSelection: (
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      source: "model_select" | "before_agent_start",
    ) => Promise<void>;
    appendModeState: (
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      activeMode: string | undefined,
    ) => void;
    getActiveMode: () => string | undefined;
    setStatus: (ctx: ExtensionContext, modeName: string | undefined) => void;
  },
): void {
  pi.on("session_start", async (_event, ctx) => {
    deps.resetRuntimeState();
    await deps.restoreMode(pi, ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    if (deps.isInternalModelChange()) {
      return;
    }
    if (deps.isApplying()) {
      deps.markNeedsResyncAfterApply();
      return;
    }
    deps.clearActiveMode();
    await deps.syncFromSelection(pi, ctx, "model_select");
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (deps.isApplying()) {
      deps.markNeedsResyncAfterApply();
      return;
    }
    await deps.syncFromSelection(pi, ctx, "before_agent_start");
    deps.appendModeState(pi, ctx, deps.getActiveMode());
  });

  pi.on("turn_start", (_event, ctx) => {
    deps.appendModeState(pi, ctx, deps.getActiveMode());
    deps.setStatus(ctx, deps.getActiveMode());
  });
}

export function registerModeEventHandlers(
  pi: ExtensionAPI,
  deps: {
    modeActivateEvent: string;
    modeSelectionApplyEvent: string;
    parseModeActivateEvent: (data: unknown) => ModeActivateEvent | undefined;
    activateMode: (
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      event: ModeActivateEvent,
    ) => Promise<void>;
    parseModeSelectionApplyEvent: (data: unknown) => ModeSelectionApplyEvent | undefined;
    applySelection: (
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      event: ModeSelectionApplyEvent,
    ) => Promise<void>;
  },
): () => void {
  const unsubscribeActivate = pi.events.on(deps.modeActivateEvent, (data) => {
    const event = deps.parseModeActivateEvent(data);
    if (!event) {
      return;
    }
    runModeActivateHandler(pi, deps, event);
  });

  const unsubscribeApplySelection = pi.events.on(deps.modeSelectionApplyEvent, (data) => {
    const event = deps.parseModeSelectionApplyEvent(data);
    if (!event) {
      return;
    }
    runModeSelectionApplyHandler(pi, deps, event);
  });

  return () => {
    unsubscribeActivate();
    unsubscribeApplySelection();
  };
}
