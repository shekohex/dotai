import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Value.Check(UnknownRecordSchema, value)) {
    return undefined;
  }

  return Value.Parse(UnknownRecordSchema, value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

async function loadJsonFile(filePath: string): Promise<unknown> {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readFirstStringDeep(
  value: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!value) {
    return undefined;
  }

  for (const key of keys) {
    const current = readString(value[key]);
    if (hasText(current)) {
      return current;
    }
  }

  for (const nested of Object.values(value)) {
    const found = readFirstStringDeep(asRecord(nested), keys);
    if (hasText(found)) {
      return found;
    }
  }

  return undefined;
}

function readDeepString(value: unknown, paths: string[][]): string | undefined {
  for (const pathKeys of paths) {
    let current: unknown = value;
    for (const key of pathKeys) {
      const record = asRecord(current);
      if (!record) {
        current = undefined;
        break;
      }
      current = record[key];
    }

    const found = readString(current);
    if (hasText(found)) {
      return found;
    }
  }

  return undefined;
}

function readDeepNumber(value: unknown, paths: string[][]): number | undefined {
  for (const pathKeys of paths) {
    let current: unknown = value;
    for (const key of pathKeys) {
      const record = asRecord(current);
      if (!record) {
        current = undefined;
        break;
      }
      current = record[key];
    }

    const found = readNumber(current);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!hasText(token)) {
    return undefined;
  }

  try {
    const parts = token.split(".");
    if (parts.length < 2) {
      return undefined;
    }

    return asRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function toIso(value: string | undefined): string | undefined {
  if (!hasText(value)) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function joinSummary(...values: Array<string | undefined>): string | undefined {
  const parts = values
    .map((value) => value?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /session expired|auth unavailable|401|403/i.test(message);
}

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

export {
  asRecord,
  clampFraction,
  clampPercent,
  decodeJwtPayload,
  formatPercent,
  hasText,
  isAuthError,
  joinSummary,
  loadJsonFile,
  readDeepNumber,
  readDeepString,
  readFirstStringDeep,
  readNumber,
  readString,
  toIso,
};
