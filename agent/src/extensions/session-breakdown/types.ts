import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import os from "node:os";
import path from "node:path";

export type ModelKey = string;
export type CwdKey = string;
export type DowKey = string;
export type TodKey = string;
export type BreakdownView = "model" | "cwd" | "dow" | "tod";

const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
export type UnknownRecord = Static<typeof UnknownRecordSchema>;

export function parseUnknownRecord(value: unknown): UnknownRecord | undefined {
  if (!Value.Check(UnknownRecordSchema, value)) {
    return undefined;
  }

  return Value.Parse(UnknownRecordSchema, value);
}

export function readStringField(
  record: UnknownRecord | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function readRecordField(
  record: UnknownRecord | undefined,
  key: string,
): UnknownRecord | undefined {
  const value = record?.[key];
  return parseUnknownRecord(value);
}

export const DOW_NAMES: DowKey[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const TOD_BUCKETS: { key: TodKey; label: string; from: number; to: number }[] = [
  { key: "after-midnight", label: "After midnight (0–5)", from: 0, to: 5 },
  { key: "morning", label: "Morning (6–11)", from: 6, to: 11 },
  { key: "afternoon", label: "Afternoon (12–16)", from: 12, to: 16 },
  { key: "evening", label: "Evening (17–21)", from: 17, to: 21 },
  { key: "night", label: "Night (22–23)", from: 22, to: 23 },
];

export function todBucketForHour(hour: number): TodKey {
  for (const b of TOD_BUCKETS) {
    if (hour >= b.from && hour <= b.to) return b.key;
  }
  return "after-midnight";
}

export function todBucketLabel(key: TodKey): string {
  return TOD_BUCKETS.find((b) => b.key === key)?.label ?? key;
}

export interface ParsedSession {
  filePath: string;
  startedAt: Date;
  dayKeyLocal: string;
  cwd: CwdKey | null;
  dow: DowKey;
  tod: TodKey;
  modelsUsed: Set<ModelKey>;
  messages: number;
  tokens: number;
  totalCost: number;
  costByModel: Map<ModelKey, number>;
  messagesByModel: Map<ModelKey, number>;
  tokensByModel: Map<ModelKey, number>;
}

export interface DayAgg {
  date: Date;
  dayKeyLocal: string;
  sessions: number;
  messages: number;
  tokens: number;
  totalCost: number;
  costByModel: Map<ModelKey, number>;
  sessionsByModel: Map<ModelKey, number>;
  messagesByModel: Map<ModelKey, number>;
  tokensByModel: Map<ModelKey, number>;
  sessionsByCwd: Map<CwdKey, number>;
  messagesByCwd: Map<CwdKey, number>;
  tokensByCwd: Map<CwdKey, number>;
  costByCwd: Map<CwdKey, number>;
  sessionsByTod: Map<TodKey, number>;
  messagesByTod: Map<TodKey, number>;
  tokensByTod: Map<TodKey, number>;
  costByTod: Map<TodKey, number>;
}

export interface RangeAgg {
  days: DayAgg[];
  dayByKey: Map<string, DayAgg>;
  sessions: number;
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  modelCost: Map<ModelKey, number>;
  modelSessions: Map<ModelKey, number>;
  modelMessages: Map<ModelKey, number>;
  modelTokens: Map<ModelKey, number>;
  cwdCost: Map<CwdKey, number>;
  cwdSessions: Map<CwdKey, number>;
  cwdMessages: Map<CwdKey, number>;
  cwdTokens: Map<CwdKey, number>;
  dowCost: Map<DowKey, number>;
  dowSessions: Map<DowKey, number>;
  dowMessages: Map<DowKey, number>;
  dowTokens: Map<DowKey, number>;
  todCost: Map<TodKey, number>;
  todSessions: Map<TodKey, number>;
  todMessages: Map<TodKey, number>;
  todTokens: Map<TodKey, number>;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface BreakdownData {
  generatedAt: Date;
  ranges: Map<number, RangeAgg>;
  palette: {
    modelColors: Map<ModelKey, RGB>;
    otherColor: RGB;
    orderedModels: ModelKey[];
  };
  cwdPalette: {
    cwdColors: Map<CwdKey, RGB>;
    otherColor: RGB;
    orderedCwds: CwdKey[];
  };
  dowPalette: {
    dowColors: Map<DowKey, RGB>;
    orderedDows: DowKey[];
  };
  todPalette: {
    todColors: Map<TodKey, RGB>;
    orderedTods: TodKey[];
  };
}

export const SESSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");
export const RANGE_DAYS = [7, 30, 90] as const;

export type MeasurementMode = "sessions" | "messages" | "tokens";
export type BreakdownProgressPhase = "scan" | "parse" | "finalize";

export interface BreakdownProgressState {
  phase: BreakdownProgressPhase;
  foundFiles: number;
  parsedFiles: number;
  totalFiles: number;
  currentFile?: string;
}
