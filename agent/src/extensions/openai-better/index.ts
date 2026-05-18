import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerOpenAIImage, _imageTest } from "./image.js";
import {
  defaultOpenAIBetterSettings,
  getOpenAIBetterSettings,
  parseSupportedModelKey,
  setOpenAIBetterFastEnabled,
  type OpenAIBetterSettings,
} from "./settings.js";
import { OPENAI_BETTER_STATUS_KEY, OPENAI_BETTER_UPDATED_EVENT } from "./types.js";

const COMMAND = "fast";
const FLAG = "fast";
const SERVICE_TIER = "priority";
const LEGACY_FAST_SERVICE_TIER = "fast";

function currentModelKey(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

function supportsFast(ctx: ExtensionContext, supportedModels: string[]): boolean {
  const current = ctx.model;
  if (!current) return false;
  return supportedModels
    .map((model) => parseSupportedModelKey(model))
    .some((model) => model?.provider === current.provider && model.id === current.id);
}

function modelList(supportedModels: string[]): string {
  return supportedModels.length > 0 ? supportedModels.join(", ") : "none configured";
}

function stateText(
  ctx: ExtensionContext,
  desiredActive: boolean,
  active: boolean,
  supportedModels: string[],
): string {
  const model = currentModelKey(ctx);
  if (active) return `Fast mode is on for ${model}.`;
  if (desiredActive) {
    return `Fast mode is requested, but inactive for unsupported model ${model}. Supported models: ${modelList(supportedModels)}.`;
  }
  return `Fast mode is off. Current model: ${model}.`;
}

function isRequestPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFastServiceTier(value: unknown): typeof SERVICE_TIER | undefined {
  return value === SERVICE_TIER || value === LEGACY_FAST_SERVICE_TIER ? SERVICE_TIER : undefined;
}

function applyFastServiceTier(payload: Record<string, unknown>): Record<string, unknown> {
  const normalizedServiceTier = normalizeFastServiceTier(payload.service_tier);
  if (normalizedServiceTier === SERVICE_TIER) {
    return payload.service_tier === SERVICE_TIER
      ? payload
      : { ...payload, service_tier: normalizedServiceTier };
  }
  return { ...payload, service_tier: SERVICE_TIER };
}

export default function betterOpenAI(pi: ExtensionAPI): void {
  let desiredActive = false;
  let active = false;

  function settings(): OpenAIBetterSettings {
    return getOpenAIBetterSettings();
  }

  function applyDesiredFastState(ctx: ExtensionContext, currentSettings = settings()): void {
    active = desiredActive && supportsFast(ctx, currentSettings.fast.supportedModels);
  }

  function formatStatus(ctx: ExtensionContext): string | undefined {
    const currentSettings = settings();
    if (!active || !supportsFast(ctx, currentSettings.fast.supportedModels)) return undefined;
    return ctx.ui.theme.fg("accent", "fast");
  }

  function refreshStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(OPENAI_BETTER_STATUS_KEY, formatStatus(ctx));
    pi.events.emit(OPENAI_BETTER_UPDATED_EVENT, { active, desiredActive });
  }

  function setActive(ctx: ExtensionContext, next: boolean): void {
    const currentSettings = settings();
    desiredActive = next;
    if (currentSettings.fast.persistState) setOpenAIBetterFastEnabled(next);
    applyDesiredFastState(ctx, currentSettings);
    refreshStatus(ctx);
    if (next && !active) {
      ctx.ui.notify(
        `Fast mode requested, but ${currentModelKey(ctx)} is unsupported. It will activate automatically when you switch to a supported model: ${modelList(currentSettings.fast.supportedModels)}.`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      stateText(ctx, desiredActive, active, currentSettings.fast.supportedModels),
      "info",
    );
  }

  pi.registerFlag(FLAG, {
    description: "Start with OpenAI fast mode enabled (service_tier=priority)",
    type: "boolean",
    default: false,
  });

  pi.registerCommand(COMMAND, {
    description: "Toggle OpenAI fast mode",
    handler: async (args, ctx) => {
      await Promise.resolve();
      const arg = args.trim().toLowerCase();
      if (arg.length === 0) {
        setActive(ctx, !desiredActive);
        return;
      }
      ctx.ui.notify("Usage: /fast", "error");
    },
  });

  registerOpenAIImage(pi, settings);

  pi.on("session_start", (_event, ctx) => {
    const currentSettings = settings();
    desiredActive = currentSettings.fast.persistState ? currentSettings.fast.enabled : false;
    if (pi.getFlag(FLAG) === true) desiredActive = true;
    applyDesiredFastState(ctx, currentSettings);
    if (desiredActive && !active) {
      ctx.ui.notify(
        `Fast mode requested, but ${currentModelKey(ctx)} is unsupported. It will activate automatically when you switch to a supported model: ${modelList(currentSettings.fast.supportedModels)}.`,
        "warning",
      );
    }
    refreshStatus(ctx);
    if (active) {
      ctx.ui.notify(
        stateText(ctx, desiredActive, active, currentSettings.fast.supportedModels),
        "info",
      );
    }
  });

  pi.on("model_select", (_event, ctx) => {
    const currentSettings = settings();
    const wasActive = active;
    applyDesiredFastState(ctx, currentSettings);
    if (active === wasActive) return;
    refreshStatus(ctx);
    ctx.ui.notify(
      active
        ? stateText(ctx, desiredActive, active, currentSettings.fast.supportedModels)
        : `Fast mode inactive for unsupported model ${currentModelKey(ctx)}.`,
      active ? "info" : "warning",
    );
  });

  pi.on("before_provider_request", (event, ctx) => {
    const currentSettings = settings();
    const shouldApplyFastMode = active && supportsFast(ctx, currentSettings.fast.supportedModels);
    const nextPayload =
      shouldApplyFastMode && isRequestPayload(event.payload)
        ? applyFastServiceTier(event.payload)
        : undefined;
    return nextPayload;
  });
}

export const _test = {
  DEFAULT_SUPPORTED_MODELS: defaultOpenAIBetterSettings.fast.supportedModels,
  DEFAULT_CONFIG: defaultOpenAIBetterSettings,
  DEFAULT_IMAGE_CONFIG: defaultOpenAIBetterSettings.image,
  SERVICE_TIER,
  LEGACY_FAST_SERVICE_TIER,
  applyFastServiceTier,
  normalizeFastServiceTier,
  parseModelKey: parseSupportedModelKey,
  supportsFast,
  imageTest: _imageTest,
};
