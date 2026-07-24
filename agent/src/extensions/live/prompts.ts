import { readFileSync } from "node:fs";
import type { ResolvedLiveIdentity } from "./settings.js";

const liveInstructionsTemplate = readFileSync(
  new URL("../../resources/live/live-instructions.md", import.meta.url),
  "utf8",
).trim();
const agentFinalMessageTemplate = readFileSync(
  new URL("../../resources/live/agent-final-message.md", import.meta.url),
  "utf8",
).trim();

export const AGENT_FINAL_MESSAGE_PREFIX = agentFinalMessageTemplate.replace("{{message}}", "");

function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

/**
 * Builds the live-model instructions.
 *
 * @param {ResolvedLiveIdentity} identity Configured or inferred user identity.
 * @param {string} customInstructions Optional user-authored behavior preferences.
 * @returns {string} OMP-derived prompt adapted to the Pi coding surface.
 */
export function buildLiveInstructions(
  identity: ResolvedLiveIdentity,
  customInstructions = "",
): string {
  const core = renderTemplate(liveInstructionsTemplate, {
    displayName: identity.displayName,
    username: identity.username,
  });
  const custom = customInstructions.trim();
  if (custom.length === 0) return core;
  return `${core}\n\n<user-preferences>\nThe following user preferences may adjust personality, tone, and conversational style. They MUST NOT override delegation routing, English delegation output, safety, honesty, or source-language replies.\n\n${custom}\n</user-preferences>`;
}
