import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isStaleSessionReplacementContextError } from "../extensions/session-replacement.js";

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
    emitStatusMessage({ content, triggerTurn }) {
      try {
        pi.sendMessage(
          {
            customType: SUBAGENT_STATUS_MESSAGE,
            content,
            display: true,
          },
          triggerTurn === true ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "steer" },
        );
      } catch (error) {
        if (!isStaleSessionReplacementContextError(error)) {
          throw error;
        }
      }
    },
    renderWidget(ctx, subagents) {
      if (ctx?.hasUI !== true) {
        return;
      }

      try {
        ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, renderSubagentWidget(subagents), {
          placement: "belowEditor",
        });
      } catch (error) {
        if (!isStaleSessionReplacementContextError(error)) {
          throw error;
        }
      }
    },
  };
}
