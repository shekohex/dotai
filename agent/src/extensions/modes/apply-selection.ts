import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ModeSpec, ModesFile } from "../../mode-utils.js";
import type { ModeSelectionApplyEvent } from "./events.js";

export async function applySelectionModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ModeSelectionApplyEvent,
): Promise<boolean> {
  if (!event.targetModel) {
    return true;
  }

  const modelApplied = await pi.setModel(event.targetModel);
  if (modelApplied) {
    return true;
  }
  if (ctx.hasUI) {
    ctx.ui.notify(
      `No API key available for ${event.targetModel.provider}/${event.targetModel.id}`,
      "warning",
    );
  }
  return false;
}

export function inferModeFromSelection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ModeSelectionApplyEvent,
  input: {
    data: ModesFile;
    activeMode: string | undefined;
    getModeSpec: (data: ModesFile, modeName: string) => ModeSpec | undefined;
    selectionSatisfiesMode: (
      spec: ModeSpec,
      selection: { provider?: string; modelId?: string; thinkingLevel: string },
    ) => boolean;
    inferActiveMode: (
      data: ModesFile,
      activeMode: string | undefined,
      selection: { provider?: string; modelId?: string; thinkingLevel: string },
    ) => string | undefined;
    currentSelection: (
      ctx: ExtensionContext,
      pi: ExtensionAPI,
    ) => { provider?: string; modelId?: string; thinkingLevel: string };
  },
): string | undefined {
  const targetSelection = {
    provider: event.targetModel?.provider ?? ctx.model?.provider,
    modelId: event.targetModel?.id ?? ctx.model?.id,
    thinkingLevel: event.thinkingLevel ?? pi.getThinkingLevel(),
  };
  const preferredModeSpec =
    event.mode === undefined ? undefined : input.getModeSpec(input.data, event.mode);
  if (
    event.mode !== undefined &&
    preferredModeSpec !== undefined &&
    input.selectionSatisfiesMode(preferredModeSpec, targetSelection)
  ) {
    return event.mode;
  }

  return input.inferActiveMode(input.data, input.activeMode, input.currentSelection(ctx, pi));
}

export async function applyModeModelSelection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modeName: string,
  spec: ModeSpec,
  hasModelSelection: (spec: ModeSpec) => spec is ModeSpec & { provider: string; modelId: string },
): Promise<boolean> {
  if (!hasModelSelection(spec)) {
    return true;
  }

  const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
  if (!model) {
    ctx.ui.notify(
      `Mode "${modeName}" references missing model ${spec.provider}/${spec.modelId}`,
      "warning",
    );
    return false;
  }

  const modelApplied = await pi.setModel(model);
  if (!modelApplied) {
    ctx.ui.notify(`No API key available for ${spec.provider}/${spec.modelId}`, "warning");
    return false;
  }

  return true;
}
