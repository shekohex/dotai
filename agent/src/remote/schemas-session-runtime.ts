import { Type } from "typebox";
import { JsonValueSchema } from "./json-schema.js";

const WorkingIndicatorOptionsSchema = Type.Object({
  frames: Type.Optional(Type.Array(Type.String())),
  intervalMs: Type.Optional(Type.Number()),
});

export const ExtensionUiRequestEventPayloadSchema = Type.Union([
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("select"),
    title: Type.String(),
    options: Type.Array(Type.String()),
    timeout: Type.Optional(Type.Number()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("multiselect"),
    title: Type.String(),
    options: Type.Array(Type.String()),
    timeout: Type.Optional(Type.Number()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("select_files"),
    title: Type.String(),
    timeout: Type.Optional(Type.Number()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("confirm"),
    title: Type.String(),
    message: Type.String(),
    timeout: Type.Optional(Type.Number()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("input"),
    title: Type.String(),
    placeholder: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Number()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("editor"),
    title: Type.String(),
    prefill: Type.Optional(Type.String()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("notify"),
    message: Type.String(),
    notifyType: Type.Optional(
      Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
    ),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setStatus"),
    statusKey: Type.String(),
    statusText: Type.Optional(Type.String()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setWorkingMessage"),
    message: Type.Optional(Type.String()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setWorkingIndicator"),
    options: Type.Optional(WorkingIndicatorOptionsSchema),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setHiddenThinkingLabel"),
    label: Type.Optional(Type.String()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setWidget"),
    widgetKey: Type.String(),
    widgetLines: Type.Optional(Type.Array(Type.String())),
    widgetPlacement: Type.Optional(
      Type.Union([Type.Literal("aboveEditor"), Type.Literal("belowEditor")]),
    ),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setTitle"),
    title: Type.String(),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setToolsExpanded"),
    expanded: Type.Boolean(),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("set_editor_text"),
    text: Type.String(),
  }),
]);

const TextContentSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
  textSignature: Type.Optional(Type.String()),
});

const ImageContentSchema = Type.Object({
  type: Type.Literal("image"),
  data: Type.String(),
  mimeType: Type.String(),
});

const ThinkingContentSchema = Type.Object({
  type: Type.Literal("thinking"),
  thinking: Type.String(),
  thinkingSignature: Type.Optional(Type.String()),
  redacted: Type.Optional(Type.Boolean()),
});

const ToolCallSchema = Type.Object({
  type: Type.Literal("toolCall"),
  id: Type.String(),
  name: Type.String(),
  arguments: Type.Record(Type.String(), JsonValueSchema),
  thoughtSignature: Type.Optional(Type.String()),
});

const UsageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  totalTokens: Type.Number(),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
});

const TranscriptUserMessageSchema = Type.Object({
  role: Type.Literal("user"),
  content: Type.Union([
    Type.String(),
    Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
  ]),
  timestamp: Type.Optional(Type.Union([Type.Number(), Type.String()])),
});

const TranscriptDeveloperMessageSchema = Type.Object({
  role: Type.Literal("developer"),
  content: Type.Union([
    Type.String(),
    Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
  ]),
  timestamp: Type.Optional(Type.Union([Type.Number(), Type.String()])),
});

export const TranscriptAssistantMessageSchema = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Array(Type.Union([TextContentSchema, ThinkingContentSchema, ToolCallSchema])),
  api: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  responseId: Type.Optional(Type.String()),
  usage: Type.Optional(UsageSchema),
  stopReason: Type.Optional(
    Type.Union([
      Type.Literal("stop"),
      Type.Literal("length"),
      Type.Literal("toolUse"),
      Type.Literal("error"),
      Type.Literal("aborted"),
    ]),
  ),
  errorMessage: Type.Optional(Type.String()),
  timestamp: Type.Optional(Type.Union([Type.Number(), Type.String()])),
});

const TranscriptToolResultMessageSchema = Type.Object({
  role: Type.Literal("toolResult"),
  toolCallId: Type.String(),
  toolName: Type.String(),
  content: Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
  details: Type.Optional(JsonValueSchema),
  isError: Type.Boolean(),
  timestamp: Type.Optional(Type.Union([Type.Number(), Type.String()])),
});

const TranscriptBashExecutionMessageSchema = Type.Object({
  role: Type.Literal("bashExecution"),
  command: Type.String(),
  output: Type.String(),
  exitCode: Type.Optional(Type.Number()),
  cancelled: Type.Boolean(),
  truncated: Type.Boolean(),
  fullOutputPath: Type.Optional(Type.String()),
  timestamp: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  excludeFromContext: Type.Optional(Type.Boolean()),
});

const TranscriptCustomMessageSchema = Type.Object({
  role: Type.Literal("custom"),
  customType: Type.String(),
  content: Type.Union([
    Type.String(),
    Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
  ]),
  display: Type.Boolean(),
  details: Type.Optional(JsonValueSchema),
  timestamp: Type.Optional(Type.Union([Type.Number(), Type.String()])),
});

const TranscriptBranchSummaryMessageSchema = Type.Object({
  role: Type.Literal("branchSummary"),
  summary: Type.String(),
  fromId: Type.String(),
  timestamp: Type.Optional(Type.Union([Type.Number(), Type.String()])),
});

const TranscriptCompactionSummaryMessageSchema = Type.Object({
  role: Type.Literal("compactionSummary"),
  summary: Type.String(),
  tokensBefore: Type.Number(),
  timestamp: Type.Optional(Type.Union([Type.Number(), Type.String()])),
});

export const TranscriptMessageTransportSchema = Type.Union([
  TranscriptUserMessageSchema,
  TranscriptDeveloperMessageSchema,
  TranscriptAssistantMessageSchema,
  TranscriptToolResultMessageSchema,
  TranscriptBashExecutionMessageSchema,
  TranscriptCustomMessageSchema,
  TranscriptBranchSummaryMessageSchema,
  TranscriptCompactionSummaryMessageSchema,
]);

export const TranscriptSchema = Type.Array(TranscriptMessageTransportSchema);

export { JsonValueSchema };
