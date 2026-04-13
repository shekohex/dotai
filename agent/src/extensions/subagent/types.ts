import type { CustomEntry } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const SUBAGENT_STATE_ENTRY = "subagent-state";
export const SUBAGENT_MESSAGE_ENTRY = "subagent-message";
export const SUBAGENT_WIDGET_KEY = "subagents";
export const SUBAGENT_STATUS_MESSAGE = "subagent-status";

export const SubagentActionSchema = Type.Union([
  Type.Literal("start"),
  Type.Literal("message"),
  Type.Literal("cancel"),
  Type.Literal("list"),
], { description: "The subagent action to run. `message` auto-resumes a dead child session before delivery when needed. There is no subagent read action; inspect tmux pane/window output directly from the parent session." });
export const SubagentDeliverySchema = Type.Union([
  Type.Literal("steer", { description: "Steers the subagent in real-time" }),
  Type.Literal("followUp", { description: "waits until the agent finish its turn and then sends this message (queue)" }),
  Type.Literal("nextTurn"),
], { description: "Optional message delivery mode for message." });
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

export const SubagentToolParamsSchema = Type.Object({
  action: SubagentActionSchema,
  name: Type.Optional(Type.String({ description: "Required for start. Display name for the child session and the tmux pane/window title shown immediately on launch." })),
  task: Type.Optional(Type.String({ description: "Required for start. Initial instruction for the child session. There is no subagent read action later, so inspect tmux pane/window output directly from the parent session for progress." })),
  mode: Type.Optional(Type.String({ description: "Optional mode name for the child session." })),
  handoff: Type.Optional(Type.Boolean({ description: "Optional for start. Reuse handoff summarization for the initial prompt." })),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for the child session." })),
  autoExit: Type.Optional(Type.Boolean({ description: "Optional override for the mode autoExit behavior." })),
  sessionId: Type.Optional(Type.String({ description: "Required for message and cancel. Use the full UUID v4 sessionId from a prior subagent result or subagent list output." })),
  message: Type.Optional(Type.String({ description: "Required for message. Sends follow-up text into the child tmux pane/window, auto-resuming the child first when its pane/window is gone. To inspect the reply, read the tmux output directly from the parent session." })),
  delivery: Type.Optional(SubagentDeliverySchema),
});

export const SubagentStateEntrySchema = Type.Object({
  event: SubagentStateEventSchema,
  sessionId: Type.String(),
  sessionPath: Type.String(),
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
  status: SubagentStatusSchema,
  exitCode: Type.Optional(Type.Number()),
  summary: Type.Optional(Type.String()),
  startedAt: Type.Number(),
  updatedAt: Type.Number(),
  completedAt: Type.Optional(Type.Number()),
}, { additionalProperties: false });

export const SubagentMessageEntrySchema = Type.Object({
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
}, { additionalProperties: false });

export type SubagentAction = Static<typeof SubagentActionSchema>;
export type SubagentDelivery = Static<typeof SubagentDeliverySchema>;
export type SubagentStateEvent = Static<typeof SubagentStateEventSchema>;
export type SubagentStatus = Static<typeof SubagentStatusSchema>;
export type SubagentToolParams = Static<typeof SubagentToolParamsSchema>;
export type SubagentStateEntry = Static<typeof SubagentStateEntrySchema>;
export type SubagentMessageEntry = Static<typeof SubagentMessageEntrySchema>;
export type SubagentStateSessionEntry = CustomEntry<SubagentStateEntry>;
export type SubagentMessageSessionEntry = CustomEntry<SubagentMessageEntry>;

export type RuntimeSubagent = SubagentStateEntry & {
  modeLabel: string;
};

export type StartSubagentParams = {
  name: string;
  task: string;
  mode?: string;
  handoff?: boolean;
  cwd?: string;
  autoExit?: boolean;
};

export type ResumeSubagentParams = {
  sessionId: string;
  task: string;
  mode?: string;
  cwd?: string;
  autoExit?: boolean;
};

export type MessageSubagentParams = {
  sessionId: string;
  message: string;
  delivery: SubagentDelivery;
};

export type MessageSubagentResult = {
  state: RuntimeSubagent;
  autoResumed: boolean;
  resumePrompt?: string;
};

export type CancelSubagentParams = {
  sessionId: string;
};

export type ListSubagentParams = Record<string, never>;

export type ChildBootstrapState = {
  sessionId: string;
  sessionPath: string;
  parentSessionId: string;
  parentSessionPath?: string;
  name: string;
  prompt: string;
  mode?: string;
  autoExit: boolean;
  autoExitTimeoutMs?: number;
  handoff: boolean;
  tools: string[];
  startedAt: number;
};

export type StartSubagentResult = {
  state: RuntimeSubagent;
  prompt: string;
};

export type ResumeSubagentResult = {
  state: RuntimeSubagent;
  prompt: string;
};

export type SubagentStartResultDetails = {
  action: "start";
  args: SubagentToolParams;
  prompt: string;
  state: RuntimeSubagent;
};

export type SubagentMessageResultDetails = {
  action: "message";
  args: SubagentToolParams;
  message: string;
  delivery: SubagentDelivery;
  state: RuntimeSubagent;
  autoResumed?: boolean;
  resumePrompt?: string;
};

export type SubagentCancelResultDetails = {
  action: "cancel";
  args: SubagentToolParams;
  state: RuntimeSubagent;
};

export type SubagentListResultDetails = {
  action: "list";
  args: SubagentToolParams;
  subagents: RuntimeSubagent[];
};

export type SubagentToolResultDetails =
  | SubagentStartResultDetails
  | SubagentMessageResultDetails
  | SubagentCancelResultDetails
  | SubagentListResultDetails;

export type SubagentToolProgressPhase = "handoff" | "launch" | "message";

export type SubagentToolProgressDetails = {
  action: "start" | "message";
  phase: SubagentToolProgressPhase;
  statusText: string;
  preview?: string;
  durationMs?: number;
  paneId?: string;
  delivery?: SubagentDelivery;
};

export type SubagentToolRenderDetails = SubagentToolResultDetails | SubagentToolProgressDetails;

export function parseSubagentStateEntry(value: unknown): SubagentStateEntry | undefined {
  if (!Value.Check(SubagentStateEntrySchema, value)) {
    return undefined;
  }

  return Value.Parse(SubagentStateEntrySchema, value);
}

export function serializeSubagentStateEntry(value: SubagentStateEntry): SubagentStateEntry {
  return Value.Parse(SubagentStateEntrySchema, value);
}

export function serializeSubagentMessageEntry(value: SubagentMessageEntry): SubagentMessageEntry {
  return Value.Parse(SubagentMessageEntrySchema, value);
}
