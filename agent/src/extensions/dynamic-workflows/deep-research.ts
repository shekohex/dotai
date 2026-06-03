import { jsString, renderWorkflowResource } from "./resource-workflows.js";

/** Deep research workflow configuration. */
export interface DeepResearchConfig {
  /** Number of distinct search angles/queries to explore. */
  angles: number;
  /** Minimum distinct sources required for a claim to survive cross-checking. */
  minSupport: number;
}

/**
 * Generate a deep-research workflow that uses the built-in websearch tool.
 *
 * The script is loaded from bundled workflow resources and reads runtime inputs from `args`.
 *
 * @returns {string} Deep research workflow script.
 */
export function generateDeepResearchWorkflow(): string {
  return renderWorkflowResource("deep-research.workflow.js");
}

/**
 * Generate a codebase audit workflow.
 *
 * @param {string} scope Codebase scope to audit.
 * @param {string[]} checks Audit checks to run.
 * @returns {string} Codebase audit workflow script.
 */
export function generateCodebaseAuditWorkflow(scope: string, checks: string[]): string {
  const description = `Codebase audit: ${scope.slice(0, 60)}`;
  const checkAgents = `[
${checks
  .map((check) => {
    const label = check
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .slice(0, 20);
    return `  () => agent('Audit ' + ${jsString(check)} + ' across: ' + scope, { label: '${label}' }),`;
  })
  .join("\n")}
]`;

  return renderWorkflowResource("codebase-audit.workflow.js", {
    scope: jsString(scope),
    description: jsString(description),
    checkAgents,
  });
}
