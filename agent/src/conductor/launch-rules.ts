import type { ResolvedRepositoryConfig } from "./config.js";
import { evaluateCondition } from "./expression.js";
import { buildExpressionContext } from "./prompt.js";
import type { WorkItem } from "./store/types.js";
import type { WorkflowFile } from "./workflow.js";
import type { WorktreePlan } from "./worktree.js";

export function selectLaunchFlags(
  workflow: WorkflowFile,
  config: ResolvedRepositoryConfig,
  workItem: WorkItem,
  plan: WorktreePlan,
  runId: string,
): string[] {
  const context = buildExpressionContext({
    config,
    workflow,
    workItem,
    plan,
    runId,
    attempt: 1,
  });
  for (const rule of workflow.frontmatter.launchRules ?? []) {
    if (evaluateCondition(rule.if, context)) return rule.flags;
  }
  return [];
}
