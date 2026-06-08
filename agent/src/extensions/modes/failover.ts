import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

import type { ModeModelCandidate, ModeSpec, ThinkingLevel } from "../../mode-utils.js";
import {
  classifyModelFailure,
  cooldownDelayMs,
  isUnavailableFailure,
  shouldFallbackImmediately,
} from "./model-failure.js";
import { hasText } from "./core.js";
import { ModelHealthStore, modelHealthKey } from "./model-health-store.js";

const UNAVAILABLE_FAILURE_THRESHOLD = 3;
const UNAVAILABLE_FAILURE_WINDOW_MS = 5 * 60_000;

type ResolvedCandidate = {
  key: string;
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  isPrimary: boolean;
};

export type ModeFailoverRuntime = {
  healthStore: ModelHealthStore;
  lastFallbackStatus?: string;
};

export function createModeFailoverRuntime(): ModeFailoverRuntime {
  return { healthStore: new ModelHealthStore() };
}

export async function restorePrimaryModelForMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: ModeFailoverRuntime,
  modeName: string | undefined,
  spec: ModeSpec | undefined,
): Promise<void> {
  if (modeName === undefined || spec === undefined) return;
  const chain = resolveCandidateChain(ctx, spec);
  const primary = chain[0];
  if (primary === undefined || !primary.isPrimary) return;
  if (runtime.healthStore.isCoolingDown(primary.key)) {
    if (ctx.model?.provider === primary.model.provider && ctx.model.id === primary.model.id) {
      await switchToFallback(pi, ctx, runtime, modeName, spec, chain, primary.key, "cooldown");
    }
    setFallbackStatus(ctx, runtime, modeName, primary.key);
    return;
  }
  if (ctx.model?.provider === primary.model.provider && ctx.model.id === primary.model.id) return;
  if (!(await applyCandidate(pi, ctx, primary, spec))) return;
  runtime.healthStore.markHealthy(primary.key);
  ctx.ui.notify(`Mode "${modeName}": primary model restored (${primary.key})`, "info");
  clearFallbackStatus(ctx, runtime);
}

export async function handleModeAssistantMessageEnd(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: ModeFailoverRuntime,
  modeName: string | undefined,
  spec: ModeSpec | undefined,
  message: AssistantMessage,
): Promise<void> {
  if (modeName === undefined || spec === undefined) return;
  if (message.stopReason !== "error" || message.errorMessage === undefined) {
    markCurrentModelHealthy(ctx, runtime);
    return;
  }

  const chain = resolveCandidateChain(ctx, spec);
  if (chain.length < 2) return;
  const failed = findCurrentCandidate(ctx, chain);
  if (failed === undefined) return;

  const classification = classifyModelFailure(message.errorMessage);
  if (shouldFallbackImmediately(classification)) {
    runtime.healthStore.markCooldown(
      failed.key,
      classification.kind,
      cooldownDelayMs(classification),
      message.errorMessage,
    );
    await switchToFallback(
      pi,
      ctx,
      runtime,
      modeName,
      spec,
      chain,
      failed.key,
      classification.kind,
    );
    return;
  }

  if (isUnavailableFailure(classification)) {
    const failures = runtime.healthStore.recordUnavailableFailure(
      failed.key,
      UNAVAILABLE_FAILURE_WINDOW_MS,
    );
    if (failures < UNAVAILABLE_FAILURE_THRESHOLD) return;
    runtime.healthStore.markCooldown(
      failed.key,
      classification.kind,
      cooldownDelayMs(classification),
      message.errorMessage,
    );
    await switchToFallback(
      pi,
      ctx,
      runtime,
      modeName,
      spec,
      chain,
      failed.key,
      classification.kind,
    );
  }
}

function resolveCandidateChain(ctx: ExtensionContext, spec: ModeSpec): ResolvedCandidate[] {
  const candidates = [primaryCandidate(spec), ...(spec.fallbacks ?? [])].filter(
    (candidate): candidate is ModeModelCandidate => candidate !== undefined,
  );
  return candidates.flatMap((candidate, index) => {
    const model = ctx.modelRegistry.find(candidate.provider, candidate.modelId);
    if (model === undefined) return [];
    return [
      {
        key: modelHealthKey(candidate.provider, candidate.modelId),
        model,
        thinkingLevel: candidate.thinkingLevel,
        isPrimary: index === 0,
      },
    ];
  });
}

function primaryCandidate(spec: ModeSpec): ModeModelCandidate | undefined {
  if (!hasText(spec.provider) || !hasText(spec.modelId)) return undefined;
  return { provider: spec.provider, modelId: spec.modelId, thinkingLevel: spec.thinkingLevel };
}

function findCurrentCandidate(
  ctx: ExtensionContext,
  chain: ResolvedCandidate[],
): ResolvedCandidate | undefined {
  return chain.find(
    (candidate) =>
      ctx.model?.provider === candidate.model.provider && ctx.model.id === candidate.model.id,
  );
}

async function switchToFallback(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: ModeFailoverRuntime,
  modeName: string,
  spec: ModeSpec,
  chain: ResolvedCandidate[],
  failedKey: string,
  reason: string,
): Promise<void> {
  for (const candidate of chain) {
    if (candidate.key === failedKey || runtime.healthStore.isCoolingDown(candidate.key)) continue;
    if (!(await applyCandidate(pi, ctx, candidate, spec))) continue;
    ctx.ui.notify(
      `Mode "${modeName}": switched to fallback ${candidate.key} (${reason})`,
      "warning",
    );
    setFallbackStatus(ctx, runtime, modeName, failedKey);
    return;
  }
}

async function applyCandidate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  candidate: ResolvedCandidate,
  spec: ModeSpec,
): Promise<boolean> {
  const applied = await pi.setModel(candidate.model);
  if (!applied) return false;
  const thinkingLevel = candidate.thinkingLevel ?? spec.thinkingLevel;
  if (thinkingLevel !== undefined) pi.setThinkingLevel(thinkingLevel);
  return true;
}

function markCurrentModelHealthy(ctx: ExtensionContext, runtime: ModeFailoverRuntime): void {
  if (ctx.model === undefined) return;
  runtime.healthStore.markHealthy(modelHealthKey(ctx.model.provider, ctx.model.id));
}

function setFallbackStatus(
  ctx: ExtensionContext,
  runtime: ModeFailoverRuntime,
  modeName: string,
  primaryKey: string,
): void {
  const active =
    ctx.model === undefined ? undefined : modelHealthKey(ctx.model.provider, ctx.model.id);
  const cooldownMs = runtime.healthStore.availableAfterMs(primaryKey);
  const text = `mode:${modeName} fallback:${active ?? "unknown"} primary:${Math.ceil(cooldownMs / 1000)}s`;
  if (runtime.lastFallbackStatus === text) return;
  runtime.lastFallbackStatus = text;
  ctx.ui.setStatus("mode-fallback", ctx.ui.theme.fg("warning", text));
}

function clearFallbackStatus(ctx: ExtensionContext, runtime: ModeFailoverRuntime): void {
  if (runtime.lastFallbackStatus === undefined) return;
  runtime.lastFallbackStatus = undefined;
  ctx.ui.setStatus("mode-fallback", undefined);
}
