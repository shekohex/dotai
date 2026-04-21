import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ModeSpec, ModesFile } from "../../mode-utils.js";

export function orderedModeNames(data: ModesFile): string[] {
  return Object.keys(data.modes).toSorted((left, right) => left.localeCompare(right));
}

export function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export function hasModelSelection(
  spec: ModeSpec,
): spec is ModeSpec & { provider: string; modelId: string } {
  return hasText(spec.provider) && hasText(spec.modelId);
}

export function getModeSpec(data: ModesFile, modeName: string): ModeSpec | undefined {
  return data.modes[modeName];
}

export function describeModeSpec(spec: ModeSpec | undefined): string | undefined {
  if (!spec) return undefined;

  const parts: string[] = [];
  if (hasModelSelection(spec)) {
    parts.push(`${spec.provider}/${spec.modelId}`);
  }
  if (hasText(spec.thinkingLevel)) {
    parts.push(`thinking:${spec.thinkingLevel}`);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function describeModeAutocomplete(
  modeName: string,
  spec: ModeSpec | undefined,
  activeMode: string | undefined,
): string | undefined {
  const parts: string[] = [];
  if (activeMode === modeName) {
    parts.push("active");
  }

  const details = describeModeSpec(spec);
  if (hasText(details)) {
    parts.push(details);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function currentSelection(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): { provider?: string; modelId?: string; thinkingLevel: string } {
  return {
    provider: ctx.model?.provider,
    modelId: ctx.model?.id,
    thinkingLevel: pi.getThinkingLevel(),
  };
}

export function matchesMode(
  spec: ModeSpec,
  selection: { provider?: string; modelId?: string; thinkingLevel: string },
): boolean {
  if (
    hasModelSelection(spec) &&
    (spec.provider !== selection.provider || spec.modelId !== selection.modelId)
  ) {
    return false;
  }

  if (hasText(spec.thinkingLevel) && spec.thinkingLevel !== selection.thinkingLevel) {
    return false;
  }

  return hasModelSelection(spec) || hasText(spec.thinkingLevel);
}

export function selectionSatisfiesMode(
  spec: ModeSpec,
  selection: { provider?: string; modelId?: string; thinkingLevel: string },
): boolean {
  if (
    hasModelSelection(spec) &&
    (spec.provider !== selection.provider || spec.modelId !== selection.modelId)
  ) {
    return false;
  }

  if (hasText(spec.thinkingLevel) && spec.thinkingLevel !== selection.thinkingLevel) {
    return false;
  }

  return true;
}

export function inferActiveMode(
  data: ModesFile,
  activeMode: string | undefined,
  selection: { provider?: string; modelId?: string; thinkingLevel: string },
): string | undefined {
  if (hasText(activeMode)) {
    const activeSpec = getModeSpec(data, activeMode);
    if (activeSpec && selectionSatisfiesMode(activeSpec, selection)) {
      return activeMode;
    }
  }

  for (const modeName of orderedModeNames(data)) {
    const spec = getModeSpec(data, modeName);
    if (spec && matchesMode(spec, selection)) {
      return modeName;
    }
  }
  return undefined;
}
