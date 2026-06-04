import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const WORKFLOW_PROGRESS_EVENT = "workflow:progress";

export const WorkflowProgressEventSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("active"),
      sessionId: Type.String(),
      cwd: Type.String(),
      runId: Type.String(),
      workflowName: Type.String(),
      elapsedSeconds: Type.Integer({ minimum: 0 }),
      phase: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("clear"),
      sessionId: Type.String(),
      cwd: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

export type WorkflowProgressEvent = Static<typeof WorkflowProgressEventSchema>;

export function parseWorkflowProgressEvent(value: unknown): WorkflowProgressEvent | undefined {
  return Value.Check(WorkflowProgressEventSchema, value)
    ? Value.Parse(WorkflowProgressEventSchema, value)
    : undefined;
}
