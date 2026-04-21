function stripMarkdownSection(content: string, heading: string): string {
  const pattern = new RegExp(`(?:^|\\n)## ${heading}\\s*[\\s\\S]*?(?=(?:\\n## )|$)`, "i");
  return content.replace(pattern, "").trim();
}

export function buildReviewAuthorTask(targetLabel: string, handoffInstruction?: string): string {
  const lines = [`Review ${targetLabel} using the review instructions in this prompt.`];
  const trimmedInstruction = handoffInstruction?.trim();
  if (trimmedInstruction !== undefined && trimmedInstruction.length > 0) {
    lines.push(`Author guidance: ${trimmedInstruction}`);
  }

  return lines.join("\n");
}

export function buildReviewHandoffPrompt(options: {
  summary: string;
  targetLabel: string;
  handoffInstruction?: string;
  parentSessionPath?: string;
}): string {
  const sections = [
    stripMarkdownSection(options.summary, "Task"),
    `## Task\n${buildReviewAuthorTask(options.targetLabel, options.handoffInstruction)}`,
    options.parentSessionPath !== undefined && options.parentSessionPath.length > 0
      ? `## Parent Session\nParent session: ${options.parentSessionPath}\nIf you need additional detail from the parent session, use \`session_query\` with \`sessionPath\` set to the path above and a focused \`question\`.`
      : undefined,
  ].filter((value): value is string => value !== undefined && value.length > 0);

  return sections.join("\n\n");
}
