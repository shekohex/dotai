import { Type } from "typebox";

export const SUBAGENT_STATE_ENTRY = "subagent-state";
export const SUBAGENT_MESSAGE_ENTRY = "subagent-message";
export const SUBAGENT_ACTIVITY_ENTRY = "subagent-activity";
export const SUBAGENT_STRUCTURED_OUTPUT_ENTRY = "subagent-structured-output";
export const SUBAGENT_WIDGET_KEY = "subagents";
export const SUBAGENT_OVERVIEW_WIDGET_KEY = "subagents-overview";
export const SUBAGENT_CHILD_WIDGET_KEY = "subagent-child";
export const SUBAGENT_STATUS_MESSAGE = "subagent-status";

export const SubagentActivityKindSchema = Type.Union([
  Type.Literal("thinking"),
  Type.Literal("tool"),
  Type.Literal("message"),
  Type.Literal("idle"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const SubagentActivityEntrySchema = Type.Object(
  {
    sessionId: Type.String(),
    kind: SubagentActivityKindSchema,
    label: Type.String(),
    detail: Type.Optional(Type.String()),
    toolName: Type.Optional(Type.String()),
    startedAt: Type.Number(),
    updatedAt: Type.Number(),
    done: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const SubagentActionSchema = Type.Union(
  [Type.Literal("start"), Type.Literal("message"), Type.Literal("cancel"), Type.Literal("list")],
  {
    description:
      "The subagent action to run. `message` auto-resumes a dead child session before delivery when needed. There is no subagent read action; inspect tmux pane/window output directly from the parent session.",
  },
);
export const SubagentDeliverySchema = Type.Union(
  [
    Type.Literal("steer", { description: "Steers the subagent in real-time" }),
    Type.Literal("followUp", {
      description: "waits until the agent finish its turn and then sends this message (queue)",
    }),
  ],
  { description: "Optional message delivery mode for message." },
);
export const SubagentCompletionNotificationSchema = Type.Object(
  {
    deliverAs: Type.Optional(SubagentDeliverySchema),
    triggerTurn: Type.Optional(Type.Boolean()),
  },
  {
    additionalProperties: false,
    description:
      "Optional completion delivery overrides. Defaults to deliverAs=steer and triggerTurn=true.",
  },
);
export const SubagentCompletionSchema = Type.Union([
  Type.Literal(false, {
    description: "Disable automatic completion status message back to parent session entirely.",
  }),
  SubagentCompletionNotificationSchema,
]);
export const SubagentStateEventSchema = Type.Union([
  Type.Literal("started"),
  Type.Literal("resumed"),
  Type.Literal("restored"),
  Type.Literal("updated"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
  Type.Literal("failed"),
]);
export const SubagentStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("idle"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
  Type.Literal("failed"),
]);

export const OutputFormatTextSchema = Type.Object(
  {
    type: Type.Literal("text"),
  },
  { additionalProperties: false },
);

export const OutputFormatJsonSchemaSchema = Type.Object(
  {
    type: Type.Literal("json_schema"),
    schema: Type.Unknown(),
    retryCount: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const OutputFormatSchema = Type.Union([
  OutputFormatTextSchema,
  OutputFormatJsonSchemaSchema,
]);

export const SubagentIpcConfigSchema = Type.Object(
  {
    endpoint: Type.String(),
    token: Type.String(),
  },
  { additionalProperties: false },
);

export const StructuredOutputErrorCodeSchema = Type.Union([
  Type.Literal("retry_exhausted"),
  Type.Literal("missing_tool_call"),
  Type.Literal("validation_failed"),
  Type.Literal("aborted"),
]);

export const StructuredOutputErrorSchema = Type.Object(
  {
    code: StructuredOutputErrorCodeSchema,
    message: Type.String(),
    retryCount: Type.Integer({ minimum: 0 }),
    attempts: Type.Integer({ minimum: 0 }),
    lastValidationError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SubagentStructuredOutputEntryStatusSchema = Type.Union([
  Type.Literal("retrying"),
  Type.Literal("captured"),
  Type.Literal("error"),
]);

export const SubagentStructuredOutputEntrySchema = Type.Object(
  {
    status: SubagentStructuredOutputEntryStatusSchema,
    attempts: Type.Integer({ minimum: 0 }),
    retryCount: Type.Integer({ minimum: 0 }),
    structured: Type.Optional(Type.Unknown()),
    error: Type.Optional(StructuredOutputErrorSchema),
    updatedAt: Type.Number(),
  },
  { additionalProperties: false },
);

export const SubagentToolParamsSchema = Type.Object({
  action: SubagentActionSchema,
  name: Type.Optional(
    Type.String({
      description:
        "Required for start. Display name for the child session and the tmux pane/window title shown immediately on launch.",
    }),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "Required for start. Initial instruction for the child session. There is no subagent read action later, so inspect tmux pane/window output directly from the parent session for progress.",
    }),
  ),
  mode: Type.Optional(Type.String({ description: "Optional mode name for the child session." })),
  handoff: Type.Optional(
    Type.Boolean({
      description: "Optional for start. Reuse handoff summarization for the initial prompt.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Optional working directory for the child session." }),
  ),
  autoExit: Type.Optional(
    Type.Boolean({ description: "Optional override for the mode autoExit behavior." }),
  ),
  persisted: Type.Optional(
    Type.Boolean({
      description:
        "Optional for start. Defaults to true (persistent). Set false for ephemeral: launches child with --no-session, no session file. Ephemeral subagents can be messaged while running but cannot be resumed after exit. Good for one-off exploration, git commits, or quick tasks where follow-up is not needed. If parent session is ephemeral, children are automatically ephemeral.",
    }),
  ),
  completion: Type.Optional(SubagentCompletionSchema),
  outputFormat: Type.Optional(
    Type.Union([
      OutputFormatTextSchema,
      Type.Object(
        {
          type: Type.Literal("json_schema"),
          schema: Type.Unknown({
            description:
              'JSON Schema object for structured output. When set, the subagent tool blocks until the child completes and returns data validated against this schema. Use for extracting structured results (e.g. {"summary", "risk", "files"}) instead of free-text. Retries on validation failure up to retryCount times.',
          }),
          retryCount: Type.Optional(
            Type.Integer({ minimum: 0, description: "Optional retry budget. Defaults to 3." }),
          ),
        },
        { additionalProperties: false },
      ),
    ]),
  ),
  sessionId: Type.Optional(
    Type.String({
      description:
        "Required for message and cancel. Use the full UUID v4 sessionId from a prior subagent result or subagent list output.",
    }),
  ),
  message: Type.Optional(
    Type.String({
      description:
        "Required for message. Sends follow-up text into the child tmux pane/window, auto-resuming the child first when its pane/window is gone. To inspect the reply, read the tmux output directly from the parent session.",
    }),
  ),
  delivery: Type.Optional(SubagentDeliverySchema),
});

export const SubagentStateEntrySchema = Type.Object(
  {
    event: SubagentStateEventSchema,
    sessionId: Type.String(),
    sessionPath: Type.Optional(Type.String()),
    persisted: Type.Optional(Type.Boolean()),
    parentSessionId: Type.String(),
    parentSessionPath: Type.Optional(Type.String()),
    name: Type.String(),
    mode: Type.Optional(Type.String()),
    cwd: Type.String(),
    paneId: Type.String(),
    task: Type.String(),
    handoff: Type.Boolean(),
    autoExit: Type.Boolean(),
    autoExitTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    autoExitTimeoutActive: Type.Optional(Type.Boolean()),
    autoExitDeadlineAt: Type.Optional(Type.Integer({ minimum: 0 })),
    completion: Type.Optional(SubagentCompletionSchema),
    status: SubagentStatusSchema,
    exitCode: Type.Optional(Type.Number()),
    summary: Type.Optional(Type.String()),
    structured: Type.Optional(Type.Unknown()),
    outputFormat: Type.Optional(OutputFormatSchema),
    structuredError: Type.Optional(StructuredOutputErrorSchema),
    startedAt: Type.Number(),
    updatedAt: Type.Number(),
    completedAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const SubagentMessageEntrySchema = Type.Object(
  {
    sessionId: Type.String(),
    message: Type.String(),
    delivery: SubagentDeliverySchema,
    createdAt: Type.Number(),
    deliveredAt: Type.Optional(Type.Number()),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("delivered"),
      Type.Literal("failed"),
    ]),
  },
  { additionalProperties: false },
);

export const ChildBootstrapStateSchema = Type.Object(
  {
    sessionId: Type.String(),
    sessionPath: Type.Optional(Type.String()),
    persisted: Type.Optional(Type.Boolean()),
    parentSessionId: Type.String(),
    parentSessionPath: Type.Optional(Type.String()),
    outcomePath: Type.Optional(Type.String()),
    name: Type.String(),
    prompt: Type.String(),
    mode: Type.Optional(Type.String()),
    autoExit: Type.Boolean(),
    autoExitTimeoutMs: Type.Optional(Type.Number()),
    handoff: Type.Boolean(),
    tools: Type.Array(Type.String()),
    outputFormat: Type.Optional(OutputFormatSchema),
    ipc: Type.Optional(SubagentIpcConfigSchema),
    startedAt: Type.Number(),
  },
  { additionalProperties: true },
);
