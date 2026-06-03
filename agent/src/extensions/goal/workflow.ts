import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const GoalWorkflowFrontmatterSchema = Type.Object(
  {
    successCriteria: Type.Optional(Type.Array(Type.String())),
    constraints: Type.Optional(Type.Array(Type.String())),
    verificationCommands: Type.Optional(Type.Array(Type.String())),
    context: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type GoalWorkflowFrontmatter = Static<typeof GoalWorkflowFrontmatterSchema>;

export interface GoalWorkflowArgs {
  objective: string;
  successCriteria: string[];
  constraints: string[];
  verificationCommands: string[];
  context: string;
  startCommit: string;
  startedAt: string;
  runId: string;
}

export function parseGoalWorkflowObjective(
  objectiveText: string,
): Omit<GoalWorkflowArgs, "startCommit" | "startedAt" | "runId"> {
  const parsed = parseFrontmatter(objectiveText);
  if (!Value.Check(GoalWorkflowFrontmatterSchema, parsed.frontmatter)) {
    throw new Error(
      "Goal workflow frontmatter must contain only supported keys: successCriteria, constraints, verificationCommands, context.",
    );
  }
  const frontmatter = Value.Parse(GoalWorkflowFrontmatterSchema, parsed.frontmatter);
  return {
    objective: parsed.body.trim(),
    successCriteria: frontmatter.successCriteria ?? [],
    constraints: frontmatter.constraints ?? [],
    verificationCommands: frontmatter.verificationCommands ?? [],
    context: frontmatter.context?.trim() ?? "",
  };
}
