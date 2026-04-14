import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { renderSubagentWidget } from "./ui.js";
import {
  SUBAGENT_MESSAGE_ENTRY,
  SUBAGENT_STATE_ENTRY,
  SUBAGENT_STATUS_MESSAGE,
  SUBAGENT_WIDGET_KEY,
  serializeSubagentMessageEntry,
  serializeSubagentStateEntry,
  type RuntimeSubagent,
  type SubagentMessageEntry,
  type SubagentStateEntry,
} from "./types.js";

export type SubagentRuntimeHooks = {
  persistState(state: SubagentStateEntry): Promise<void>;
  persistMessage(entry: SubagentMessageEntry): Promise<void>;
  emitStatusMessage(options: { content: string; triggerTurn?: boolean }): void;
  renderWidget(ctx: ExtensionContext | undefined, subagents: RuntimeSubagent[]): void;
};

export function createDefaultSubagentRuntimeHooks(pi: ExtensionAPI): SubagentRuntimeHooks {
  return {
    async persistState(state) {
      pi.appendEntry(SUBAGENT_STATE_ENTRY, serializeSubagentStateEntry(state));
    },
    async persistMessage(entry) {
      pi.appendEntry(SUBAGENT_MESSAGE_ENTRY, serializeSubagentMessageEntry(entry));
    },
    emitStatusMessage({ content, triggerTurn }) {
      pi.sendMessage(
        {
          customType: SUBAGENT_STATUS_MESSAGE,
          content,
          display: true,
        },
        triggerTurn ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "steer" },
      );
    },
    renderWidget(ctx, subagents) {
      if (!ctx?.hasUI) {
        return;
      }

      ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, renderSubagentWidget(subagents), {
        placement: "belowEditor",
      });
    },
  };
}
