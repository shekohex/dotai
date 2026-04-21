import type { CustomEntry } from "@mariozechner/pi-coding-agent";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  ChildBootstrapStateSchema,
  OutputFormatSchema,
  StructuredOutputErrorCodeSchema,
  StructuredOutputErrorSchema,
  SubagentActionSchema,
  SubagentDeliverySchema,
  SubagentMessageEntrySchema,
  SubagentStateEntrySchema,
  SubagentStateEventSchema,
  SubagentStatusSchema,
  SubagentStructuredOutputEntrySchema,
  SubagentToolParamsSchema,
} from "./schema-definitions.js";

export {
  ChildBootstrapStateSchema,
  OutputFormatJsonSchemaSchema,
  OutputFormatSchema,
  OutputFormatTextSchema,
  StructuredOutputErrorCodeSchema,
  StructuredOutputErrorSchema,
  SUBAGENT_MESSAGE_ENTRY,
  SUBAGENT_STATE_ENTRY,
  SUBAGENT_STATUS_MESSAGE,
  SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
  SUBAGENT_WIDGET_KEY,
  SubagentActionSchema,
  SubagentDeliverySchema,
  SubagentMessageEntrySchema,
  SubagentStateEntrySchema,
  SubagentStateEventSchema,
  SubagentStatusSchema,
  SubagentStructuredOutputEntrySchema,
  SubagentStructuredOutputEntryStatusSchema,
  SubagentToolParamsSchema,
} from "./schema-definitions.js";

export type SubagentAction = Static<typeof SubagentActionSchema>;
export type SubagentDelivery = Static<typeof SubagentDeliverySchema>;
export type SubagentStateEvent = Static<typeof SubagentStateEventSchema>;
export type SubagentStatus = Static<typeof SubagentStatusSchema>;
export type TSchemaBase = TSchema;
export type OutputFormat<TSchemaValue = unknown> =
  | { type: "text" }
  | { type: "json_schema"; schema: TSchemaValue; retryCount?: number };
export type StructuredOutputErrorCode = Static<typeof StructuredOutputErrorCodeSchema>;
export type StructuredOutputError = Static<typeof StructuredOutputErrorSchema>;
export type SubagentToolParams = Static<typeof SubagentToolParamsSchema>;
export type SubagentStateEntry = Static<typeof SubagentStateEntrySchema>;
export type SubagentMessageEntry = Static<typeof SubagentMessageEntrySchema>;
export type SubagentStructuredOutputEntry = Static<typeof SubagentStructuredOutputEntrySchema>;
export type SubagentStateSessionEntry = CustomEntry<SubagentStateEntry>;
export type SubagentMessageSessionEntry = CustomEntry<SubagentMessageEntry>;

export type RuntimeSubagent = SubagentStateEntry & {
  modeLabel: string;
};

type StartSubagentBaseParams = {
  name: string;
  task: string;
  mode?: string;
  handoff?: boolean;
  cwd?: string;
  autoExit?: boolean;
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
    structured: cloneStructuredValue(state.structured),
    outputFormat: cloneOutputFormat(state.outputFormat),
    structuredError: cloneStructuredError(state.structuredError),
  };
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
  return value;
}

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
  return Value.Parse(SubagentStructuredOutputEntrySchema, value);
}
