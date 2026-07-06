import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { parseJsonValue } from "./json.js";

export const RunLogEntrySchema = Type.Object({
  runId: Type.String(),
  kind: Type.String(),
  createdAt: Type.String(),
  payload: Type.Unknown(),
});

export type RunLogEntry = Static<typeof RunLogEntrySchema>;

export function runLogPath(stateRoot: string, runId: string): string {
  return join(stateRoot, "run", `${runId}-logs.jsonl`);
}

export async function appendRunLog(stateRoot: string, entry: RunLogEntry): Promise<void> {
  const validated = Value.Parse(RunLogEntrySchema, entry);
  const path = runLogPath(stateRoot, validated.runId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(validated)}\n`);
}

export async function readRunLogs(stateRoot: string, runId: string): Promise<RunLogEntry[]> {
  let text: string;
  try {
    text = await readFile(runLogPath(stateRoot, runId), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => Value.Parse(RunLogEntrySchema, parseJsonValue(line, `${runId} log entry`)));
}
