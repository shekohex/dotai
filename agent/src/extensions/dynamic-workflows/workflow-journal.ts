import { Type, type Static } from "typebox";

export const JournalEntryBaseSchema = Type.Object({
  index: Type.Number(),
  hash: Type.String(),
  label: Type.String(),
  prompt: Type.String(),
  phase: Type.Optional(Type.String()),
  mode: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
});

export const StartedJournalEntrySchema = Type.Intersect([
  JournalEntryBaseSchema,
  Type.Object({
    status: Type.Literal("started"),
    sessionId: Type.String(),
    sessionPath: Type.String(),
    paneId: Type.Optional(Type.String()),
    muxBackend: Type.Optional(Type.String()),
  }),
]);

export const CompletedJournalEntrySchema = Type.Intersect([
  JournalEntryBaseSchema,
  Type.Object({
    status: Type.Literal("completed"),
    result: Type.Unknown(),
    tokens: Type.Number(),
    sessionId: Type.Optional(Type.String()),
    sessionPath: Type.Optional(Type.String()),
    paneId: Type.Optional(Type.String()),
    muxBackend: Type.Optional(Type.String()),
  }),
]);

export const FailedJournalEntrySchema = Type.Intersect([
  JournalEntryBaseSchema,
  Type.Object({
    status: Type.Literal("failed"),
    error: Type.String(),
    retryable: Type.Boolean(),
    code: Type.Optional(Type.String()),
    recoverable: Type.Optional(Type.Boolean()),
    sessionId: Type.Optional(Type.String()),
    sessionPath: Type.Optional(Type.String()),
    paneId: Type.Optional(Type.String()),
    muxBackend: Type.Optional(Type.String()),
  }),
]);

export const JournalEntrySchema = Type.Union([
  StartedJournalEntrySchema,
  CompletedJournalEntrySchema,
  FailedJournalEntrySchema,
]);

export type JournalEntryBase = Static<typeof JournalEntryBaseSchema>;
export type StartedJournalEntry = Static<typeof StartedJournalEntrySchema>;
export type CompletedJournalEntry = Static<typeof CompletedJournalEntrySchema>;
export type FailedJournalEntry = Static<typeof FailedJournalEntrySchema>;
export type JournalEntry = Static<typeof JournalEntrySchema>;

export type AgentJournalInput = JournalEntryBase;

export interface AgentJournalSessionRef {
  sessionId: string;
  sessionPath: string;
  paneId?: string;
  muxBackend?: string;
}

export function createStartedJournalEntry(
  input: AgentJournalInput & AgentJournalSessionRef,
): StartedJournalEntry {
  return { ...input, status: "started" };
}

export function createCompletedJournalEntry(
  input: AgentJournalInput & Partial<AgentJournalSessionRef>,
  result: unknown,
  tokens: number,
): CompletedJournalEntry {
  return { ...input, status: "completed", result, tokens };
}

export function createFailedJournalEntry(
  input: AgentJournalInput & Partial<AgentJournalSessionRef>,
  error: string,
  retryable: boolean,
  code?: string,
  recoverable?: boolean,
): FailedJournalEntry {
  return { ...input, status: "failed", error, retryable, code, recoverable };
}
