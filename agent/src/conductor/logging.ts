import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { parseJsonValue } from "./json.js";

type Writable = { write(text: string): unknown };

export type ConductorLogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface ConductorLogger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  trace(message: string, context?: Record<string, unknown>): void;
}

export class ConsoleConductorLogger implements ConductorLogger {
  constructor(
    private readonly output: Writable,
    private readonly verbosity = 0,
    private readonly now: () => Date = () => new Date(),
  ) {}

  error(message: string, context?: Record<string, unknown>): void {
    this.write("error", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write("warn", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write("info", message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.verbosity >= 1) this.write("debug", message, context);
  }

  trace(message: string, context?: Record<string, unknown>): void {
    if (this.verbosity >= 2) this.write("trace", message, context);
  }

  private write(
    level: ConductorLogLevel,
    message: string,
    context: Record<string, unknown> | undefined,
  ): void {
    const suffix = context === undefined ? "" : ` ${JSON.stringify(context)}`;
    this.output.write(`${this.now().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`);
  }
}

export const noopConductorLogger: ConductorLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
};

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
