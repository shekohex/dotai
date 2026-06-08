import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { ModelFailureKind } from "./model-failure.js";

const MODEL_HEALTH_FILE = "model-health.json";

const ModelHealthEntrySchema = Type.Object(
  {
    state: Type.Union([Type.Literal("healthy"), Type.Literal("cooldown")]),
    reason: Type.Optional(Type.String()),
    until: Type.Optional(Type.Number()),
    failures: Type.Optional(Type.Number()),
    unavailableFailures: Type.Optional(Type.Number()),
    firstUnavailableAt: Type.Optional(Type.Number()),
    lastError: Type.Optional(Type.String()),
    lastFailureAt: Type.Optional(Type.Number()),
    lastSuccessAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const ModelHealthFileSchema = Type.Object(
  {
    version: Type.Literal(1),
    models: Type.Record(Type.String(), ModelHealthEntrySchema),
  },
  { additionalProperties: true },
);

type ModelHealthFile = Static<typeof ModelHealthFileSchema>;
export type ModelHealthEntry = Static<typeof ModelHealthEntrySchema>;

export function modelHealthKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export class ModelHealthStore {
  constructor(private readonly path = join(getAgentDir(), MODEL_HEALTH_FILE)) {}

  isCoolingDown(key: string, now = Date.now()): boolean {
    const entry = this.read().models[key];
    return entry?.state === "cooldown" && (entry.until ?? 0) > now;
  }

  availableAfterMs(key: string, now = Date.now()): number {
    const entry = this.read().models[key];
    if (entry?.state !== "cooldown") return 0;
    return Math.max(0, (entry.until ?? 0) - now);
  }

  markCooldown(key: string, kind: ModelFailureKind, delayMs: number, error: string): void {
    const file = this.read();
    const previous = file.models[key];
    const until = Date.now() + delayMs;
    file.models[key] = {
      ...previous,
      state: "cooldown",
      reason: kind,
      until: Math.max(previous?.until ?? 0, until),
      failures: (previous?.failures ?? 0) + 1,
      unavailableFailures: 0,
      firstUnavailableAt: undefined,
      lastError: error,
      lastFailureAt: Date.now(),
    };
    this.write(file);
  }

  recordUnavailableFailure(key: string, windowMs: number): number {
    const now = Date.now();
    const file = this.read();
    const previous = file.models[key];
    const firstUnavailableAt = previous?.firstUnavailableAt ?? now;
    const resetWindow = now - firstUnavailableAt > windowMs;
    const nextFirstUnavailableAt = resetWindow ? now : firstUnavailableAt;
    const nextFailures = resetWindow ? 1 : (previous?.unavailableFailures ?? 0) + 1;
    file.models[key] = {
      ...previous,
      state: previous?.state ?? "healthy",
      unavailableFailures: nextFailures,
      firstUnavailableAt: nextFirstUnavailableAt,
      lastFailureAt: now,
    };
    this.write(file);
    return nextFailures;
  }

  markHealthy(key: string): void {
    const file = this.read();
    const previous = file.models[key];
    if (previous === undefined) return;
    if (
      previous.state === "healthy" &&
      previous.reason === undefined &&
      previous.until === undefined &&
      previous.failures === undefined &&
      (previous.unavailableFailures ?? 0) === 0 &&
      previous.firstUnavailableAt === undefined &&
      previous.lastError === undefined &&
      previous.lastFailureAt === undefined
    ) {
      return;
    }
    file.models[key] = {
      ...previous,
      state: "healthy",
      reason: undefined,
      until: undefined,
      failures: undefined,
      unavailableFailures: 0,
      firstUnavailableAt: undefined,
      lastError: undefined,
      lastFailureAt: undefined,
      lastSuccessAt: Date.now(),
    };
    this.write(file);
  }

  read(): ModelHealthFile {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      if (Value.Check(ModelHealthFileSchema, parsed)) {
        return this.pruneExpired(Value.Parse(ModelHealthFileSchema, parsed));
      }
      console.warn(`Ignoring invalid model health file: ${this.path}`);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { version: 1, models: {} };
      console.warn(`Failed to read model health file ${this.path}: ${String(error)}`);
    }
    return { version: 1, models: {} };
  }

  private pruneExpired(file: ModelHealthFile): ModelHealthFile {
    const now = Date.now();
    const models = Object.fromEntries(
      Object.entries(file.models).map(([key, entry]) => [
        key,
        entry.state === "cooldown" && (entry.until ?? 0) <= now
          ? { ...entry, state: "healthy" as const, reason: undefined, until: undefined }
          : entry,
      ]),
    );
    return { version: 1, models };
  }

  private write(file: ModelHealthFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
    renameSync(tmpPath, this.path);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
