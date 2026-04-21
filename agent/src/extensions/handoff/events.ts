import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  applyPendingSelection,
  getPendingCommandHandoff,
  pendingToolHandoffState,
  setPendingCommandHandoff,
  startNewSessionInPlace,
  type HandoffRuntimeState,
} from "./shared.js";

async function handleHandoffAgentEnd(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const pending = pendingToolHandoffState.pending;
  if (!pending) {
    return;
  }

  pendingToolHandoffState.pending = undefined;
  pendingToolHandoffState.contextCutoffTimestamp = Date.now();
  startNewSessionInPlace(ctx, pending.parentSession);
  await applyPendingSelection(pi, ctx, pending.overrides);
  setTimeout(() => {
    pi.sendUserMessage(pending.prompt);
  }, 0);
}

function handleHandoffContext(
  event: ContextEvent,
): { messages?: ContextEvent["messages"] } | undefined {
  const cutoff = pendingToolHandoffState.contextCutoffTimestamp;
  if (cutoff === undefined) {
    return undefined;
  }

  const messages = event.messages.filter((message) => message.timestamp >= cutoff);
  if (messages.length === 0) {
    return undefined;
  }
  return { messages };
}

async function handleHandoffSessionStart(
  pi: ExtensionAPI,
  state: HandoffRuntimeState,
  event: { reason: string },
  ctx: ExtensionContext,
): Promise<void> {
  state.ctx = ctx;
  state.pendingNewSessionCtx?.resolve(ctx);
  pendingToolHandoffState.contextCutoffTimestamp = undefined;
  pendingToolHandoffState.pending = undefined;
  if (event.reason !== "new") {
    return;
  }

  const pendingCommandHandoff = getPendingCommandHandoff();
  if (!pendingCommandHandoff) {
    return;
  }

  await applyPendingSelection(pi, ctx, pendingCommandHandoff.overrides);
  setPendingCommandHandoff(undefined);
  if (pendingCommandHandoff.autoSend) {
    setTimeout(() => {
      pi.sendUserMessage(pendingCommandHandoff.prompt);
    }, 0);
    return;
  }
  if (!ctx.hasUI) {
    return;
  }

  ctx.ui.setEditorText(pendingCommandHandoff.prompt);
  ctx.ui.notify("Handoff ready. Submit when ready.", "info");
}

export { handleHandoffAgentEnd, handleHandoffContext, handleHandoffSessionStart };
