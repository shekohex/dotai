import { Key } from "@mariozechner/pi-tui";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ModeActivateEvent, ModeSelectionApplyEvent } from "./events.js";

type ModeSource = "command" | "shortcut" | "session_start" | "model_select" | "before_agent_start";

export function registerModeCommand(
  pi: ExtensionAPI,
  deps: {
    getModeArgumentCompletions: (prefix: string) => AutocompleteItem[] | null;
    showModePicker: (pi: ExtensionAPI, ctx: ExtensionContext) => Promise<void>;
    promptForModeName: (ctx: ExtensionContext, title: string) => Promise<string | undefined>;
    storeMode: (pi: ExtensionAPI, ctx: ExtensionContext, modeName: string) => Promise<void>;
    reloadModes: (pi: ExtensionAPI, ctx: ExtensionContext) => Promise<void>;
    applyMode: (
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      modeName: string,
      source: ModeSource,
    ) => Promise<boolean>;
  },
): void {
  pi.registerCommand("mode", {
    description:
      "Select and store prompt modes: /mode, /mode <name>, /mode store <name>, /mode reload",
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

      if (tokens[0] === "store") {
        const name =
          tokens[1] ?? (await deps.promptForModeName(ctx, "Store current setup as mode"));
        if (!name) {
          return;
        }
        await deps.storeMode(pi, ctx, name);
        return;
      }

      if (tokens[0] === "reload") {
        await deps.reloadModes(pi, ctx);
        return;
      }

      await deps.applyMode(pi, ctx, tokens[0], "command");
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
    markNeedsResyncAfterApply: () => void;
    syncFromSelection: (
      pi: ExtensionAPI,
      ctx: ExtensionContext,
      source: "model_select" | "before_agent_start",
    ) => Promise<void>;
    appendModeState: (pi: ExtensionAPI, activeMode: string | undefined) => void;
    getActiveMode: () => string | undefined;
    setStatus: (ctx: ExtensionContext, modeName: string | undefined) => void;
  },
): void {
  pi.on("session_start", async (_event, ctx) => {
    deps.resetRuntimeState();
    await deps.restoreMode(pi, ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    if (deps.isApplying()) {
      deps.markNeedsResyncAfterApply();
      return;
    }
    await deps.syncFromSelection(pi, ctx, "model_select");
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (deps.isApplying()) {
      deps.markNeedsResyncAfterApply();
      return;
    }
    await deps.syncFromSelection(pi, ctx, "before_agent_start");
  });

  pi.on("turn_start", (_event, ctx) => {
    deps.appendModeState(pi, deps.getActiveMode());
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
): void {
  pi.events.on(deps.modeActivateEvent, (data) => {
    const event = deps.parseModeActivateEvent(data);
    if (!event) {
      return;
    }
    void deps.activateMode(pi, event.ctx, event);
  });

  pi.events.on(deps.modeSelectionApplyEvent, (data) => {
    const event = deps.parseModeSelectionApplyEvent(data);
    if (!event) {
      return;
    }

    void (async () => {
      try {
        await deps.applySelection(pi, event.ctx, event);
        event.done?.resolve();
      } catch (error) {
        event.done?.reject(error);
      }
    })();
  });
}
