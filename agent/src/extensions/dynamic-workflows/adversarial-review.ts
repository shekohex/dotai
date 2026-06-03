import { jsString, renderWorkflowResource } from "./resource-workflows.js";

/** Adversarial review workflow configuration. */
export interface AdversarialReviewConfig {
  /** Number of independent reviewers per finding. */
  reviewerCount: number;
  /** Whether to filter out findings that do not survive cross-checking. */
  filterContested: boolean;
  /** Minimum agreement threshold, from 0 to 1. */
  agreementThreshold: number;
}

/**
 * Generate an adversarial-review workflow.
 *
 * @returns {string} Adversarial-review workflow script.
 */
export function generateAdversarialReviewWorkflow(): string {
  return renderWorkflowResource("adversarial-review.workflow.js");
}

/**
 * Generate a multi-perspective analysis workflow.
 *
 * @param {string} topic Topic to analyze.
 * @param {string[]} perspectives Perspectives to include.
 * @returns {string} Multi-perspective workflow script.
 */
export function generateMultiPerspectiveWorkflow(topic: string, perspectives: string[]): string {
  const description = `Analyze from ${perspectives.length} different perspectives`;
  const perspectiveAgents = `[
${perspectives
  .map((perspective) => {
    const label = perspective
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .slice(0, 20);
    return `  () => agent('Analyze from ' + ${jsString(perspective)} + ' perspective: ' + topic, { label: '${label}', mode: 'ask' }),`;
  })
  .join("\n")}
]`;

  return renderWorkflowResource("multi-perspective.workflow.js", {
    description: jsString(description),
    perspectiveAgents,
    topic: jsString(topic),
  });
}
