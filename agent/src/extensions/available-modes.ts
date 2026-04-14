import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { loadModesFile, type ModeSpec } from "../mode-utils.js";

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

export async function loadAvailableModes(cwd: string): Promise<AvailableMode[]> {
  const loaded = await loadModesFile(cwd);
  return Object.entries(loaded.data.modes)
    .sort(([left], [right]) => compareModeNames(left, right))
    .map(([name, spec]) => ({ name, spec }));
}

export function formatAvailableModesXml(modes: AvailableMode[]): string {
  if (modes.length === 0) {
    return "<available_modes>\n</available_modes>";
  }

  const sortedModes = modes.slice().sort((left, right) => compareModeNames(left.name, right.name));

  return [
    "<available_modes>",
    ...sortedModes.map(({ name, spec }) => {
      const attrs = [`name="${escapeXmlAttribute(name)}"`];
      if (spec.provider && spec.modelId) {
        const model = `${spec.provider}/${spec.modelId}`;
        attrs.push(`model="${escapeXmlAttribute(model)}"`);
      }
      if (spec.thinkingLevel) {
        attrs.push(`thinkingLevel="${escapeXmlAttribute(spec.thinkingLevel)}"`);
      }
      if (spec.description) {
        attrs.push(`description="${escapeXmlAttribute(spec.description)}"`);
      }
      return `  <mode ${attrs.join(" ")} />`;
    }),
    "</available_modes>",
  ].join("\n");
}

export async function buildAvailableModesPromptGuideline(
  cwd: string,
  heading: string,
): Promise<string> {
  return `${heading}\n${formatAvailableModesXml(await loadAvailableModes(cwd))}`;
}

export async function buildAvailableModesPromptGuidelines(
  ctx: Pick<ExtensionContext, "cwd">,
  heading: string,
): Promise<string[]> {
  return [await buildAvailableModesPromptGuideline(ctx.cwd, heading)];
}
