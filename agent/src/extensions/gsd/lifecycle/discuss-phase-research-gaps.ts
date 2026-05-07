import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { buildAssumptionsDraft } from "./discuss-phase-assumptions.js";
import type { DiscussCheckpoint } from "../state/schema.js";
import type { CurrentPhaseSelection } from "../state/runtime.js";

type PromptInput = (
  ctx: ExtensionCommandContext,
  checkpoint: DiscussCheckpoint,
  title: string,
  placeholder: string,
  fallback: string,
  textReplyReader: { consume: () => string | undefined },
) => Promise<string | undefined>;

type ResetAssumptionsDerivedState = (checkpoint: DiscussCheckpoint) => void;

export async function resolveAssumptionsResearchGaps(input: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  checkpoint: DiscussCheckpoint;
  current: CurrentPhaseSelection;
  textReplyReader: { consume: () => string | undefined };
  rawInput: string | undefined;
  promptInput: PromptInput;
  writeCheckpoint: (checkpoint: DiscussCheckpoint) => void;
  notifyStop: (checkpoint: DiscussCheckpoint) => void;
  hydrateCheckpointSideChannels: (checkpoint: DiscussCheckpoint) => void;
  resetAssumptionsDerivedState: ResetAssumptionsDerivedState;
}): Promise<"resolved" | "checkpoint"> {
  let researchSummary =
    input.rawInput !== undefined && input.rawInput.trim().length > 0
      ? input.textReplyReader.consume()
      : undefined;

  if (researchSummary === undefined && input.checkpoint.auto) {
    input.checkpoint.pendingPrompt = [
      `Assumptions route paused for phase ${input.current.phase.number} ${input.current.phase.name}.`,
      "External research still required before context can be written:",
      ...input.checkpoint.assumptionsResearchGaps.map((item) => `- ${item}`),
    ].join("\n");
    input.checkpoint.promptOptions = [];
    input.writeCheckpoint(input.checkpoint);
    input.notifyStop(input.checkpoint);
    return "checkpoint";
  }

  if (researchSummary === undefined && (input.ctx.hasUI || input.checkpoint.text)) {
    researchSummary = await input.promptInput(
      input.ctx,
      input.checkpoint,
      "Research gap resolution",
      "Summarize completed research or findings",
      "Research complete.",
      input.textReplyReader,
    );
  }

  if (researchSummary === undefined || researchSummary.trim().length === 0) {
    input.checkpoint.pendingPrompt = [
      `Assumptions route paused for phase ${input.current.phase.number} ${input.current.phase.name}.`,
      "External research still required before context can be written:",
      ...input.checkpoint.assumptionsResearchGaps.map((item) => `- ${item}`),
      "",
      "Resume by supplying completed research summary.",
    ].join("\n");
    input.checkpoint.promptOptions = [];
    input.writeCheckpoint(input.checkpoint);
    input.notifyStop(input.checkpoint);
    return "checkpoint";
  }

  input.checkpoint.draft.discussionLog.push(`Research gap resolution: ${researchSummary}`);
  input.checkpoint.draft.existingCodeInsights.push(`Research update: ${researchSummary}`);
  input.resetAssumptionsDerivedState(input.checkpoint);
  const assumptionsResult = await buildAssumptionsDraft(
    input.pi,
    input.ctx,
    input.checkpoint.draft,
    input.checkpoint,
    input.current.phase.name,
  );
  input.checkpoint.draft = assumptionsResult.draft;
  input.checkpoint.assumptionsAutoReady = assumptionsResult.allHighConfidence;
  input.checkpoint.assumptionsResearchGaps = assumptionsResult.researchGaps;
  input.hydrateCheckpointSideChannels(input.checkpoint);
  input.checkpoint.stage = "final-loop";
  if (input.checkpoint.assumptionsResearchGaps.length > 0) {
    input.checkpoint.pendingPrompt = [
      `Assumptions route paused for phase ${input.current.phase.number} ${input.current.phase.name}.`,
      "External research still required before context can be written:",
      ...input.checkpoint.assumptionsResearchGaps.map((item) => `- ${item}`),
      "",
      "Resume by supplying completed research summary.",
    ].join("\n");
    input.checkpoint.promptOptions = [];
    input.writeCheckpoint(input.checkpoint);
    input.notifyStop(input.checkpoint);
    return "checkpoint";
  }
  return input.checkpoint.assumptionsResearchGaps.length === 0 ? "resolved" : "checkpoint";
}
