export function composeImproveContext(input: {
  pfmEnabled: boolean;
  improvementHookContent: string | null;
}): string | null {
  const sections: string[] = [];

  if (input.pfmEnabled) {
    sections.push(PFM_REMINDER);
  }

  if (input.improvementHookContent !== null && input.improvementHookContent.length > 0) {
    sections.push(
      [
        "[Plannotator Improvement Hook]",
        "The following corrective instructions were generated from analysis of previous plan denial patterns.",
        "Apply these guidelines when writing your plan:\n",
        input.improvementHookContent,
      ].join("\n"),
    );
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n---\n\n");
}

export const PFM_REMINDER = `[Plannotator Flavored Markdown]
This plan will be reviewed in Plannotator, which renders GitHub Flavored Markdown plus the extensions below. Use these features when they make the plan clearer for the reviewer; do not force them in.

Code-file links
Reference real source files inline so the reviewer gets clickable badges and code previews.
  \`packages/server/index.ts\`
  \`packages/server/index.ts:42\`
  \`packages/server/index.ts:10-20\`
  [the handler](packages/server/index.ts:42)

Callouts and alerts
  > [!NOTE]
  > [!TIP]
  > [!WARNING]
  > [!CAUTION]
  > [!IMPORTANT]
  :::tip
  Body with **inline markdown**.
  :::

Tables
Pipe tables are interactive and good for comparisons, files-to-change lists, and risk summaries.

Task lists
Use \`- [ ]\` and \`- [x]\` for actionable steps.

Diagrams
Code fences with \`mermaid\` or \`graphviz\` render as live diagrams.

Other extras
  - Wiki-links: [[architecture]]
  - Hex color swatches: #1a2bcc
  - @username and #123 link to GitHub when a repo is detected

Plain prose is always fine. Prefer code-file links over pasted snippets, and use callouts or tables when they make the plan easier to scan.`;
