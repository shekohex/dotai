import { renderWorkflowResource } from "./resource-workflows.js";

export function generateGoalWorkflow(): string {
  return renderWorkflowResource("goal.workflow.js");
}
