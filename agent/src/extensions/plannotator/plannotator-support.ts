import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getStartupErrorMessage } from "./plannotator-events.js";
import {
  isCurrentPiSessionDifferentFrom,
  notifyCurrentPiSession,
  sendUserMessageToCurrentPiSession,
  withCurrentPiSessionFallbackHeader,
  type PiSessionIdentity,
} from "./current-pi-session.js";
import { hasSessionMovedPastEntry } from "./assistant-message.js";

export type SavedPhaseState = {
  activeTools: string[];
  model?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
};

export type PersistedPlannotatorState = {
  phase: "idle" | "planning" | "executing";
  lastSubmittedPath?: string;
  savedState?: SavedPhaseState;
};

export function getPlanReviewAvailabilityWarning(options: {
  hasUI: boolean;
  hasPlanHtml: boolean;
}): string | null {
  const { hasUI, hasPlanHtml } = options;
  if (hasUI && hasPlanHtml) return null;
  if (!hasUI && !hasPlanHtml) {
    return "Plannotator: interactive plan review is unavailable in this session (no UI support and missing built assets). Plans will auto-approve on exit_plan_mode.";
  }
  if (!hasUI) {
    return "Plannotator: interactive plan review is unavailable in this session (no UI support). Plans will auto-approve on exit_plan_mode.";
  }
  return "Plannotator: interactive plan review assets are missing. Rebuild the extension to restore the browser UI. Plans will auto-approve on exit_plan_mode.";
}

export function safeNotify(
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error" = "info",
  origin?: PiSessionIdentity,
): void {
  try {
    ctx.ui.notify(message, type);
  } catch {
    notifyCurrentPiSession(message, type, origin);
  }
}

export function reportBackgroundError(
  ctx: ExtensionContext,
  message: string,
  err: unknown,
  origin?: PiSessionIdentity,
): void {
  const detail = getStartupErrorMessage(err);
  console.error(`${message}: ${detail}`);
  safeNotify(ctx, `${message}: ${detail}`, "error", origin);
}

function excerptText(text: string, maxChars = 1000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}...`;
}

function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function anchorMessageFeedback(feedback: string, originalMessage: string): string {
  return `This feedback applies to the earlier assistant response excerpted below:

${blockquote(excerptText(originalMessage))}

User feedback:
${feedback}`;
}

export function shouldAnchorLastMessageFeedback(
  ctx: ExtensionContext,
  entryId: string,
  origin: PiSessionIdentity,
): boolean {
  if (isCurrentPiSessionDifferentFrom(origin)) return true;
  try {
    return hasSessionMovedPastEntry(ctx, entryId);
  } catch {
    return true;
  }
}

function reportCurrentSessionSendFailure(
  message: string,
  err: unknown,
  origin: PiSessionIdentity,
): void {
  const detail = getStartupErrorMessage(err);
  console.error(`${message}: ${detail}`);
  notifyCurrentPiSession(`${message}: ${detail}`, "error", origin);
}

function trySendUserMessageToDifferentCurrentSession(
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
  options: Parameters<ExtensionAPI["sendUserMessage"]>[1],
  message: string,
  origin: PiSessionIdentity,
): boolean {
  const result = sendUserMessageToCurrentPiSession(
    withCurrentPiSessionFallbackHeader(content),
    options,
    origin,
  );
  if (result.ok) return true;
  if (result.reason === "send-failed") {
    reportCurrentSessionSendFailure(message, result.error, origin);
    return true;
  }
  return false;
}

export function sendUserMessageWithCurrentSessionFallback(
  pi: ExtensionAPI,
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
  options: Parameters<ExtensionAPI["sendUserMessage"]>[1],
  message: string,
  origin: PiSessionIdentity,
): void {
  if (trySendUserMessageToDifferentCurrentSession(content, options, message, origin)) return;
  try {
    pi.sendUserMessage(content, options);
  } catch (err) {
    if (trySendUserMessageToDifferentCurrentSession(content, options, message, origin)) return;
    throw err;
  }
}
