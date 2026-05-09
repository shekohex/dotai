import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawnRole } from "../subagents.js";
import type { DiscussCheckpoint, DiscussDraft } from "../state/schema.js";

const AssumptionsAnalyzerOutputSchema = Type.Object(
  {
    assumptions: Type.Array(
      Type.Object(
        {
          area: Type.String(),
          assumption: Type.String(),
          why: Type.String(),
          consequenceIfWrong: Type.String(),
          confidence: Type.Union([
            Type.Literal("Confident"),
            Type.Literal("Likely"),
            Type.Literal("Unclear"),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
    externalResearch: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

function normalizeResearchGapItems(items: string[]): string[] {
  return items.filter((item) => item.trim().length > 0 && item.trim().toLowerCase() !== "none");
}

function normalizeDraftDecisionIds(draft: DiscussDraft): DiscussDraft {
  draft.implementationDecisions = draft.implementationDecisions.map((decision, index) => ({
    ...decision,
    id: `D-${String(index + 1).padStart(2, "0")}`,
  }));
  return draft;
}

function appendUnique(items: string[], nextItems: string[]): string[] {
  for (const item of nextItems.map((value) => value.trim()).filter((value) => value.length > 0)) {
    if (!items.includes(item)) {
      items.push(item);
    }
  }
  return items;
}

function parseAssumptionsAnalyzerOutput(text: string): unknown {
  const assumptions: Array<{
    area: string;
    assumption: string;
    why: string;
    consequenceIfWrong: string;
    confidence: "Confident" | "Likely" | "Unclear";
  }> = [];
  const externalResearch: string[] = [];
  const blocks = text
    .split(/^###\s+/m)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const area = lines[0]?.replace(/\s*\(.+\)$/u, "").trim();
    if (
      area === undefined ||
      area === "Needs External Research" ||
      area.startsWith("## Assumptions")
    ) {
      continue;
    }
    const assumptionLine = lines.find((line) => line.startsWith("- **Assumption:**"));
    const whyLine = lines.find((line) => line.startsWith("- **Why this way:**"));
    const ifWrongLine = lines.find((line) => line.startsWith("- **If wrong:**"));
    const confidenceLine = lines.find((line) => line.startsWith("- **Confidence:**"));
    if (
      assumptionLine === undefined ||
      whyLine === undefined ||
      ifWrongLine === undefined ||
      confidenceLine === undefined
    ) {
      throw new Error(`Assumptions analyzer output malformed: incomplete block for area ${area}`);
    }
    const assumption = assumptionLine.replace("- **Assumption:**", "").trim();
    const why = whyLine.replace("- **Why this way:**", "").trim();
    const consequenceIfWrong = ifWrongLine.replace("- **If wrong:**", "").trim();
    const confidence = confidenceLine.replace("- **Confidence:**", "").trim();
    if (assumption.length === 0 || why.length === 0 || consequenceIfWrong.length === 0) {
      throw new Error(`Assumptions analyzer output malformed: empty field for area ${area}`);
    }
    if (confidence === "Confident" || confidence === "Likely" || confidence === "Unclear") {
      assumptions.push({ area, assumption, why, consequenceIfWrong, confidence });
      continue;
    }
    throw new Error(`Assumptions analyzer output malformed: invalid confidence for area ${area}`);
  }
  const externalResearchSection = text.match(/## Needs External Research([\s\S]*)$/u)?.[1];
  if (externalResearchSection !== undefined) {
    for (const line of externalResearchSection.split(/\r?\n/u)) {
      const trimmed = line.replace(/^-\s*/u, "").trim();
      if (trimmed.length > 0) {
        externalResearch.push(trimmed);
      }
    }
  }
  return { assumptions, externalResearch: normalizeResearchGapItems(externalResearch) };
}

export async function buildAssumptionsDraft(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  draft: DiscussDraft,
  checkpoint: DiscussCheckpoint,
  phaseName: string,
): Promise<{ draft: DiscussDraft; allHighConfidence: boolean; researchGaps: string[] }> {
  const task = [
    `<phase>${checkpoint.phase} ${phaseName}</phase>`,
    `<phase_goal>${draft.phaseBoundary}</phase_goal>`,
    `<prior_decisions>${checkpoint.priorContextSummary}</prior_decisions>`,
    `<codebase_hints>${checkpoint.scoutSummary}</codebase_hints>`,
    `<calibration_tier>minimal_decisive</calibration_tier>`,
  ].join("\n");
  const result = await spawnRole(pi, ctx, "assumptions-analyzer", task);
  const parsed = parseAssumptionsAnalyzerOutput(result.capturedOutput ?? "");
  if (!Value.Check(AssumptionsAnalyzerOutputSchema, parsed)) {
    throw new Error("Assumptions analyzer output did not match expected structure");
  }
  if (parsed.assumptions.length === 0) {
    throw new Error("Assumptions analyzer returned zero assumptions");
  }
  let allHighConfidence = true;
  draft.discussionLog.push("Assumptions analyzer summary:");
  for (const assumption of parsed.assumptions) {
    if (assumption.confidence !== "Confident") {
      allHighConfidence = false;
    }
    draft.implementationDecisions.push({
      id: "",
      area: assumption.area,
      decision: `${assumption.assumption} (${assumption.confidence})`,
      source: "assumption",
    });
    draft.existingCodeInsights.push(`${assumption.area}: ${assumption.why}`);
    draft.deferredIdeas.push(`If wrong: ${assumption.consequenceIfWrong}`);
    draft.discussionLog.push(`- ${assumption.area}: ${assumption.assumption}`);
  }
  appendUnique(draft.specificIdeas, parsed.externalResearch);
  return {
    draft: normalizeDraftDecisionIds(draft),
    allHighConfidence,
    researchGaps: parsed.externalResearch,
  };
}
