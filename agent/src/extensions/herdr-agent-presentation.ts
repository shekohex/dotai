import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { toolLabel } from "./pi-osc/tool-presentations.js";

export type HerdrMetadataTokens = {
  context: string | null;
  model: string | null;
  summary: string | null;
  tool: string | null;
};

export function sessionTitle(ctx: ExtensionContext): string {
  const sessionName = ctx.sessionManager.getSessionName();
  const cwdBasename = path.basename(ctx.cwd);
  return sessionName !== undefined && sessionName.length > 0
    ? `π - ${sessionName} - ${cwdBasename}`
    : `π - ${cwdBasename}`;
}

export function sessionTabTitle(ctx: ExtensionContext): string {
  const sessionName = ctx.sessionManager.getSessionName()?.trim();
  return sessionName !== undefined && sessionName.length > 0 ? sessionName : path.basename(ctx.cwd);
}

export function metadataTokens(
  ctx: ExtensionContext,
  summary: string,
  tool: string | null,
): HerdrMetadataTokens {
  return {
    context: contextToken(ctx),
    model: modelToken(ctx),
    summary,
    tool,
  };
}

export function messageActivitySummary(eventType: string): string | undefined {
  switch (eventType) {
    case "thinking_start":
    case "thinking_delta":
      return "Thinking";
    case "text_start":
    case "text_delta":
      return "Writing";
    case "toolcall_start":
    case "toolcall_delta":
      return "Preparing tool";
    default:
      return undefined;
  }
}

export function toolActivitySummary(toolName: string, args: unknown): string {
  return toolLabel(toolName, args) ?? `Using ${toolName}`;
}

export function customStatusForState(
  state: "working" | "blocked" | "idle",
  message?: string,
): string {
  if (message !== undefined && message.length > 0) return message;
  if (state === "working") return "working";
  if (state === "blocked") return "needs input";
  return "ready";
}

function contextToken(ctx: ExtensionContext): string | null {
  try {
    const percent = ctx.getContextUsage()?.percent;
    return percent === null || percent === undefined || !Number.isFinite(percent)
      ? null
      : `${Math.round(percent)}% ctx`;
  } catch {
    return null;
  }
}

function modelToken(ctx: ExtensionContext): string | null {
  try {
    const modelName = ctx.model?.name.trim();
    return modelName === undefined || modelName.length === 0 ? null : modelName;
  } catch {
    return null;
  }
}
