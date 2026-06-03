import type { CustomEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ContextPruneConfig } from "../extensions/context-prune/types.js";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import {
  ChildBootstrapStateSchema,
  OutputFormatSchema,
  SubagentCompletionNotificationSchema,
  SubagentCompletionSchema,
  StructuredOutputErrorCodeSchema,
  StructuredOutputErrorSchema,
  SubagentActivityEntrySchema,
  SubagentActivityKindSchema,
  SubagentActionSchema,
  SubagentDeliverySchema,
  SubagentIpcConfigSchema,
  SubagentMessageEntrySchema,
  SubagentStateEntrySchema,
  SubagentStateEventSchema,
  SubagentStatusSchema,
  SubagentStructuredOutputEntrySchema,
  SubagentToolParamsSchema,
  TokenUsageSchema,
} from "./schema-definitions.js";

export {
  ChildBootstrapStateSchema,
  OutputFormatJsonSchemaSchema,
  OutputFormatSchema,
  OutputFormatTextSchema,
  SubagentCompletionNotificationSchema,
  SubagentCompletionSchema,
  SUBAGENT_ACTIVITY_ENTRY,
  StructuredOutputErrorCodeSchema,
  StructuredOutputErrorSchema,
  SUBAGENT_MESSAGE_ENTRY,
  SUBAGENT_CHILD_WIDGET_KEY,
  SUBAGENT_OVERVIEW_WIDGET_KEY,
  SUBAGENT_STATE_ENTRY,
  SUBAGENT_STATUS_MESSAGE,
  SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
  SUBAGENT_WIDGET_KEY,
  SubagentActivityEntrySchema,
  SubagentActivityKindSchema,
  SubagentActionSchema,
  SubagentDeliverySchema,
  SubagentIpcConfigSchema,
  SubagentMessageEntrySchema,
  SubagentStateEntrySchema,
  SubagentStateEventSchema,
  SubagentStatusSchema,
  SubagentStructuredOutputEntrySchema,
  SubagentStructuredOutputEntryStatusSchema,
  SubagentToolParamsSchema,
  TokenUsageSchema,
} from "./schema-definitions.js";

export type SubagentAction = Static<typeof SubagentActionSchema>;
export type SubagentDelivery = Static<typeof SubagentDeliverySchema>;
export type SubagentCompletionNotification = Static<typeof SubagentCompletionNotificationSchema>;
export type SubagentCompletion = Static<typeof SubagentCompletionSchema>;
export type SubagentStateEvent = Static<typeof SubagentStateEventSchema>;
export type SubagentStatus = Static<typeof SubagentStatusSchema>;
export type TSchemaBase = TSchema;
export type OutputFormat<TSchemaValue = unknown> =
  | { type: "text" }
  | { type: "json_schema"; schema: TSchemaValue; retryCount?: number };
export type StructuredOutputErrorCode = Static<typeof StructuredOutputErrorCodeSchema>;
export type StructuredOutputError = Static<typeof StructuredOutputErrorSchema>;
export type SubagentActivityKind = Static<typeof SubagentActivityKindSchema>;
export type SubagentActivityEntry = Static<typeof SubagentActivityEntrySchema>;
export type SubagentIpcConfig = Static<typeof SubagentIpcConfigSchema>;
export type SubagentToolParams = Static<typeof SubagentToolParamsSchema>;
export type SubagentStateEntry = Static<typeof SubagentStateEntrySchema>;
export type SubagentMessageEntry = Static<typeof SubagentMessageEntrySchema>;
export type SubagentStructuredOutputEntry = Static<typeof SubagentStructuredOutputEntrySchema>;
export type SubagentStateSessionEntry = CustomEntry<SubagentStateEntry>;
export type SubagentMessageSessionEntry = CustomEntry<SubagentMessageEntry>;
export type SubagentActivitySessionEntry = CustomEntry<SubagentActivityEntry>;
export type TokenUsage = Static<typeof TokenUsageSchema>;

export type RuntimeSubagent = SubagentStateEntry & {
  modeLabel: string;
  activity?: SubagentActivityEntry;
};

type PersistableSubagentStateEntry = SubagentStateEntry & {
  modeLabel?: string;
};

type StartSubagentBaseParams = {
  name: string;
  task: string;
  mode?: string;
  model?: string;
  toolNames?: string[];
  customTools?: ToolDefinition[];
  handoff?: boolean;
  cwd?: string;
  autoExit?: boolean;
  persisted?: boolean;
  contextPrune?: Partial<ContextPruneConfig>;
  completion?: SubagentCompletion;
};

export type StartSubagentParamsText = StartSubagentBaseParams & {
  outputFormat?: { type: "text" };
};

export type StartSubagentParamsJsonSchema<TSchemaValue extends TSchemaBase> =
  StartSubagentBaseParams & {
    outputFormat: { type: "json_schema"; schema: TSchemaValue; retryCount?: number };
  };

export type StartSubagentParams<TSchemaValue extends TSchemaBase = TSchemaBase> =
  StartSubagentBaseParams & {
    outputFormat?: OutputFormat<TSchemaValue>;
  };

export type ResumeSubagentParams<TSchemaValue extends TSchemaBase = TSchemaBase> = {
  sessionId: string;
  task: string;
  name?: string;
  sessionPath?: string;
  mode?: string;
  model?: string;
  cwd?: string;
  autoExit?: boolean;
  persisted?: boolean;
  toolNames?: string[];
  customTools?: ToolDefinition[];
  outputFormat?: OutputFormat<TSchemaValue>;
  completion?: SubagentCompletion;
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

export type ChildBootstrapState = Static<typeof ChildBootstrapStateSchema>;

export type StartSubagentBaseResult = {
  state: RuntimeSubagent;
  prompt: string;
};

export type SpawnOutcome<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type StartSubagentResult = StartSubagentBaseResult;

export type StartSubagentResultText = SpawnOutcome<StartSubagentBaseResult, StructuredOutputError>;

export type StartSubagentResultJsonSchema<TSchemaValue extends TSchemaBase> = SpawnOutcome<
  StartSubagentBaseResult & { structured: Static<TSchemaValue> },
  StructuredOutputError
>;

export type ResumeSubagentResult = {
  state: RuntimeSubagent;
  prompt: string;
};

export type SubagentStartResultDetails = {
  action: "start";
  args: SubagentToolParams;
  prompt: string;
  state: RuntimeSubagent;
  structured?: unknown;
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

export function cloneRuntimeSubagent(state: RuntimeSubagent): RuntimeSubagent {
  return {
    ...state,
    activity: cloneActivity(state.activity),
    structured: cloneStructuredValue(state.structured),
    completion: cloneCompletion(state.completion),
    outputFormat: cloneOutputFormat(state.outputFormat),
    structuredError: cloneStructuredError(state.structuredError),
    tokenUsage: cloneTokenUsage(state.tokenUsage),
    tools: state.tools?.slice(),
  };
}

function cloneTokenUsage(tokenUsage: TokenUsage | undefined): TokenUsage | undefined {
  if (!tokenUsage) {
    return undefined;
  }

  return { ...tokenUsage };
}

function cloneActivity(
  activity: SubagentActivityEntry | undefined,
): SubagentActivityEntry | undefined {
  if (!activity) {
    return undefined;
  }

  return { ...activity };
}

function cloneStructuredValue(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== "object") {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function cloneOutputFormat(outputFormat: OutputFormat | undefined): OutputFormat | undefined {
  if (!outputFormat) {
    return undefined;
  }
  if (outputFormat.type === "text") {
    return { type: "text" };
  }
  const schema = cloneStructuredValue(outputFormat.schema);
  if (outputFormat.retryCount === undefined) {
    return { type: "json_schema", schema };
  }
  return { type: "json_schema", schema, retryCount: outputFormat.retryCount };
}

function cloneCompletion(
  completion: SubagentCompletion | undefined,
): SubagentCompletion | undefined {
  if (completion === undefined || completion === false) {
    return completion;
  }

  return { ...completion };
}

function cloneStructuredError(
  structuredError: StructuredOutputError | undefined,
): StructuredOutputError | undefined {
  if (!structuredError) {
    return undefined;
  }
  return { ...structuredError };
}

export function parseChildBootstrapState(value: unknown): ChildBootstrapState | undefined {
  if (!Value.Check(ChildBootstrapStateSchema, value)) {
    return undefined;
  }
  const parsed = Value.Parse(ChildBootstrapStateSchema, value);
  return {
    ...parsed,
    persisted: parsed.persisted ?? true,
  };
}

export function parseSubagentStateEntry(value: unknown): SubagentStateEntry | undefined {
  if (!Value.Check(SubagentStateEntrySchema, value)) {
    return undefined;
  }
  const parsed = Value.Parse(SubagentStateEntrySchema, value);
  return {
    ...parsed,
    persisted: parsed.persisted ?? true,
  };
}

export function serializeSubagentStateEntry(
  value: PersistableSubagentStateEntry,
): SubagentStateEntry {
  const {
    modeLabel: _modeLabel,
    activity: _activity,
    ...entry
  } = value as PersistableSubagentStateEntry & {
    activity?: SubagentActivityEntry;
  };
  const normalizedEntry = {
    ...entry,
    persisted: entry.persisted ?? true,
  };
  if (!Value.Check(SubagentStateEntrySchema, normalizedEntry)) {
    throw new Error("Invalid subagent state entry");
  }
  return normalizedEntry;
}

export function serializeSubagentMessageEntry(value: SubagentMessageEntry): SubagentMessageEntry {
  if (!Value.Check(SubagentMessageEntrySchema, value)) {
    throw new Error("Invalid subagent message entry");
  }
  return value;
}

export function parseSubagentActivityEntry(value: unknown): SubagentActivityEntry | undefined {
  if (!Value.Check(SubagentActivityEntrySchema, value)) {
    return undefined;
  }
  return Value.Parse(SubagentActivityEntrySchema, value);
}

export function serializeSubagentActivityEntry(
  value: SubagentActivityEntry,
): SubagentActivityEntry {
  if (!Value.Check(SubagentActivityEntrySchema, value)) {
    throw new Error("Invalid subagent activity entry");
  }
  return value;
}

export function parseSubagentStructuredOutputEntry(
  value: unknown,
): SubagentStructuredOutputEntry | undefined {
  if (!Value.Check(SubagentStructuredOutputEntrySchema, value)) {
    return undefined;
  }
  return Value.Parse(SubagentStructuredOutputEntrySchema, value);
}

export function serializeSubagentStructuredOutputEntry(
  value: SubagentStructuredOutputEntry,
): SubagentStructuredOutputEntry {
  if (!Value.Check(SubagentStructuredOutputEntrySchema, value)) {
    throw new Error("Invalid subagent structured output entry");
  }
  return value;
}
