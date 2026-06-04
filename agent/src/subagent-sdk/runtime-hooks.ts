import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { isStaleSessionReplacementContextError } from "../extensions/session-replacement.js";

import {
  createSubagentDashboardWidget,
  createSubagentFullscreenComponent,
  mergeSubagentsWithTerminalRetention,
} from "./ui.js";
import {
  SUBAGENT_MESSAGE_ENTRY,
  SUBAGENT_OVERVIEW_WIDGET_KEY,
  SUBAGENT_STATE_ENTRY,
  SUBAGENT_STATUS_MESSAGE,
  serializeSubagentMessageEntry,
  serializeSubagentStateEntry,
  type RuntimeSubagent,
  type SubagentMessageEntry,
  type SubagentStateEntry,
} from "./types.js";

export type SubagentRuntimeHooks = {
  persistState(state: SubagentStateEntry): Promise<void>;
  persistMessage(entry: SubagentMessageEntry): Promise<void>;
  emitStatusMessage(options: {
    content: string;
    deliverAs?: "steer" | "followUp";
    triggerTurn?: boolean;
  }): void;
  renderWidget(ctx: ExtensionContext | undefined, subagents: RuntimeSubagent[]): void;
};

export type DefaultSubagentRuntimeHooksOptions = {
  title?: string;
  terminalRetentionMs?: number;
};

type SubagentRuntimeUiControls = {
  toggle(): void;
  setExpanded(nextExpanded: boolean): void;
  showFullscreen(ctx: ExtensionContext): Promise<void>;
  render(ctx: ExtensionContext | undefined): void;
};

function hasSubagentRuntimeControlApi(
  pi: ExtensionAPI,
): pi is ExtensionAPI & Pick<ExtensionAPI, "registerCommand" | "registerShortcut"> {
  return typeof pi.registerCommand === "function" && typeof pi.registerShortcut === "function";
}

function registerSubagentRuntimeControls(
  pi: ExtensionAPI,
  controls: SubagentRuntimeUiControls,
): void {
  if (!hasSubagentRuntimeControlApi(pi)) {
    return;
  }

  pi.registerCommand("subagents", {
    description: "Show or toggle live subagent dashboard",
    async handler(args, ctx) {
      const action = args.trim();
      if (action === "fullscreen" || action === "full") {
        await controls.showFullscreen(ctx);
        return;
      }
      if (action === "expand") {
        controls.setExpanded(true);
      } else if (action === "collapse") {
        controls.setExpanded(false);
      } else {
        controls.toggle();
      }
      controls.render(ctx);
    },
  });

  pi.registerShortcut(Key.ctrlAlt("a"), {
    description: "Toggle subagent dashboard",
    handler(ctx) {
      controls.toggle();
      controls.render(ctx);
    },
  });
}

export function createDefaultSubagentRuntimeHooks(
  pi: ExtensionAPI,
  options: DefaultSubagentRuntimeHooksOptions = {},
): SubagentRuntimeHooks {
  let expanded = false;
  let lastCtx: ExtensionContext | undefined;
  let currentSubagents: RuntimeSubagent[] = [];
  let visibleSubagents: RuntimeSubagent[] = [];
  const terminalRetentionMs = options.terminalRetentionMs ?? 15_000;
  const title = options.title ?? "Subagents";

  const renderMergedWidget = (ctx: ExtensionContext | undefined): void => {
    if (ctx === undefined) return;
    if (!ctx.hasUI) {
      return;
    }

    visibleSubagents = mergeSubagentsWithTerminalRetention({
      previous: visibleSubagents,
      next: currentSubagents,
      retentionMs: terminalRetentionMs,
    });

    try {
      ctx.ui.setWidget(
        SUBAGENT_OVERVIEW_WIDGET_KEY,
        visibleSubagents.length === 0
          ? undefined
          : createSubagentDashboardWidget({
              subagents: visibleSubagents,
              title,
              mode: expanded ? "expanded" : "compact",
              maxRows: expanded ? 8 : 4,
            }),
        {
          placement: "aboveEditor",
        },
      );
    } catch (error) {
      if (!isStaleSessionReplacementContextError(error)) {
        throw error;
      }
    }
  };

  const showFullscreen = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      return;
    }

    visibleSubagents = mergeSubagentsWithTerminalRetention({
      previous: visibleSubagents,
      next: currentSubagents,
      retentionMs: terminalRetentionMs,
    });

    if (visibleSubagents.length === 0) {
      ctx.ui.notify("No subagents to show", "info");
      return;
    }

    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        createSubagentFullscreenComponent({
          subagents: visibleSubagents,
          title,
          done,
        })(tui, theme),
      {
        overlay: true,
        overlayOptions: {
          width: "95%",
          maxHeight: "90%",
          anchor: "center",
        },
      },
    );
  };

  registerSubagentRuntimeControls(pi, {
    toggle() {
      expanded = !expanded;
    },
    setExpanded(nextExpanded) {
      expanded = nextExpanded;
    },
    showFullscreen,
    render: renderMergedWidget,
  });

  return {
    persistState(state) {
      try {
        pi.appendEntry(SUBAGENT_STATE_ENTRY, serializeSubagentStateEntry(state));
      } catch (error) {
        if (!isStaleSessionReplacementContextError(error)) {
          throw error;
        }
      }
      return Promise.resolve();
    },
    persistMessage(entry) {
      try {
        pi.appendEntry(SUBAGENT_MESSAGE_ENTRY, serializeSubagentMessageEntry(entry));
      } catch (error) {
        if (!isStaleSessionReplacementContextError(error)) {
          throw error;
        }
      }
      return Promise.resolve();
    },
    emitStatusMessage({ content, deliverAs, triggerTurn }) {
      try {
        pi.sendMessage(
          {
            customType: SUBAGENT_STATUS_MESSAGE,
            content,
            display: true,
          },
          triggerTurn === true
            ? { deliverAs: deliverAs ?? "steer", triggerTurn: true }
            : { deliverAs: deliverAs ?? "steer" },
        );
      } catch (error) {
        if (!isStaleSessionReplacementContextError(error)) {
          throw error;
        }
      }
    },
    renderWidget(ctx, subagents) {
      lastCtx = ctx;
      currentSubagents = subagents;
      renderMergedWidget(lastCtx);
    },
  };
}
