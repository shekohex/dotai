import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadModeRegistry, type ModeSpec } from "../mode-utils.js";

export type AvailableMode = {
  name: string;
  spec: ModeSpec;
};

function compareModeNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;");
}

export async function loadAvailableModes(): Promise<AvailableMode[]> {
  const modes = await loadModeRegistry();
  return Object.entries(modes.resolvedData.modes)
    .toSorted(([left], [right]) => compareModeNames(left, right))
    .map(([name, spec]) => ({ name, spec }));
}

export function formatAvailableModesXml(modes: AvailableMode[]): string {
  if (modes.length === 0) {
    return "<available_modes>\n</available_modes>";
  }

  const sortedModes = modes
    .slice()
    .toSorted((left, right) => compareModeNames(left.name, right.name));

  return [
    "<available_modes>",
    ...sortedModes.map(({ name, spec }) => {
      const attrs = [`name="${escapeXmlAttribute(name)}"`];
      if (
        spec.provider !== undefined &&
        spec.provider.length > 0 &&
        spec.modelId !== undefined &&
        spec.modelId.length > 0
      ) {
        const model = `${spec.provider}/${spec.modelId}`;
        attrs.push(`model="${escapeXmlAttribute(model)}"`);
      }
      if (spec.thinkingLevel !== undefined) {
        attrs.push(`thinkingLevel="${escapeXmlAttribute(spec.thinkingLevel)}"`);
      }
      if (spec.description !== undefined && spec.description.length > 0) {
        attrs.push(`description="${escapeXmlAttribute(spec.description)}"`);
      }
      return `  <mode ${attrs.join(" ")} />`;
    }),
    "</available_modes>",
  ].join("\n");
}

export function formatAvailableModesCompact(modes: AvailableMode[]): string {
  if (modes.length === 0) {
    return "(none)";
  }

  return modes
    .slice()
    .toSorted((left, right) => compareModeNames(left.name, right.name))
    .map(({ name, spec }) => {
      const description = (spec.description ?? "")
        .replace(/^Use me when you want (?:to )?/iu, "")
        .replace(/\.$/u, "")
        .trim();
      return description.length > 0 ? `- ${name}: ${description}` : `- ${name}`;
    })
    .join("\n");
}

export async function buildAvailableModesPromptGuideline(heading: string): Promise<string> {
  return `${heading}\n${formatAvailableModesCompact(await loadAvailableModes())}`;
}

export async function buildAvailableModesPromptGuidelines(
  _ctx: Pick<ExtensionContext, "cwd">,
  heading: string,
): Promise<string[]> {
  return [await buildAvailableModesPromptGuideline(heading)];
}
