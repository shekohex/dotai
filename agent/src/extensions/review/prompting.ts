import type { ParsedReviewArgs, ReviewExecutionOptions } from "./deps.js";

export function buildReviewTaskPrompt(input: {
  targetLabel: string;
  prompt: string;
  generatedHandoffPrompt: string | undefined;
  projectGuidelines: string | null | undefined;
  customInstructions: string | undefined;
  extraInstruction: string | undefined;
}): string {
  const promptSections = [
    `Review target:\n- ${input.targetLabel}`,
    `Review instructions:\n${input.prompt}`,
    input.customInstructions !== undefined && input.customInstructions.length > 0
      ? `Shared custom review instructions:\n${input.customInstructions}`
      : undefined,
    input.extraInstruction !== undefined && input.extraInstruction.length > 0
      ? `Additional user-provided review instruction:\n${input.extraInstruction}`
      : undefined,
    input.generatedHandoffPrompt !== undefined && input.generatedHandoffPrompt.length > 0
      ? `Author handoff:\n${input.generatedHandoffPrompt}`
      : undefined,
    typeof input.projectGuidelines === "string" && input.projectGuidelines.length > 0
      ? `Project review guidelines:\n${input.projectGuidelines}`
      : undefined,
  ].filter((value): value is string => value !== undefined && value.length > 0);

  return [
    "Please perform a code review using the built-in review mode.",
    ...promptSections,
    "Return findings in the required review format.",
  ].join("\n\n");
}

export function buildReviewExecutionOptions(parsed: ParsedReviewArgs): ReviewExecutionOptions {
  const extraInstruction = parsed.extraInstruction?.trim();
  const handoffInstruction = parsed.handoffInstruction?.trim();
  return {
    extraInstruction:
      extraInstruction !== undefined && extraInstruction.length > 0 ? extraInstruction : undefined,
    handoffRequested: parsed.handoffRequested,
    handoffInstruction:
      handoffInstruction !== undefined && handoffInstruction.length > 0
        ? handoffInstruction
        : undefined,
  };
}
