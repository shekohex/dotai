import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ReferenceMention } from "./runtime.js";

export const REFERENCE_EXPANSION_MESSAGE = "reference-expansion";

const ReferenceMentionSchema = Type.Object({
  raw: Type.String(),
  alias: Type.String(),
  suffix: Type.String(),
  resolvedPath: Type.Optional(Type.String()),
  available: Type.Boolean(),
  error: Type.Optional(Type.String()),
});

const ReferenceExpansionDetailsSchema = Type.Object({
  mentions: Type.Array(ReferenceMentionSchema),
});

export type ReferenceExpansionDetails = Static<typeof ReferenceExpansionDetailsSchema>;

export function buildReferenceExpansionContent(mentions: ReferenceMention[]): string {
  if (mentions.length === 0) {
    return "";
  }
  return [
    "Project reference mentions resolved:",
    ...mentions.map((mention) => {
      if (mention.available && mention.resolvedPath !== undefined) {
        return `- ${mention.raw} -> ${mention.resolvedPath}`;
      }
      return `- ${mention.raw} -> unavailable (${mention.error ?? "reference unavailable"})`;
    }),
  ].join("\n");
}

function parseDetails(details: unknown): ReferenceExpansionDetails | undefined {
  if (!Value.Check(ReferenceExpansionDetailsSchema, details)) {
    return undefined;
  }
  return Value.Parse(ReferenceExpansionDetailsSchema, details);
}

function createReferenceExpansionRenderer(): MessageRenderer<ReferenceExpansionDetails> {
  return (message, _options, theme) => {
    const details = parseDetails(message.details);
    const lines = [theme.fg("muted", theme.italic("reference mentions"))];

    if (details === undefined || details.mentions.length === 0) {
      const content = typeof message.content === "string" ? message.content : "";
      lines.push(theme.fg("muted", content));
    } else {
      for (const mention of details.mentions) {
        const marker = mention.available ? theme.fg("success", "·") : theme.fg("error", "·");
        const alias = theme.fg("accent", theme.bold(mention.raw));
        const target = mention.available
          ? theme.fg("dim", mention.resolvedPath ?? "")
          : theme.fg("error", mention.error ?? "unavailable");
        lines.push(`${marker} ${alias} ${theme.fg("dim", "→")} ${target}`);
      }
    }

    const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  };
}

export function registerReferenceMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(REFERENCE_EXPANSION_MESSAGE, createReferenceExpansionRenderer());
}
