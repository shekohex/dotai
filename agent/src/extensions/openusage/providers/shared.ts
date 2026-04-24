import { Type } from "typebox";
import { Value } from "typebox/value";

const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Value.Check(UnknownRecordSchema, value)) {
    return undefined;
  }

  return Value.Parse(UnknownRecordSchema, value);
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

export function readNumber(value: unknown): number | undefined {
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

  const normalized = trimmed.endsWith("%") ? trimmed.slice(0, -1).trim() : trimmed;
  const direct = Number(normalized.replaceAll(",", ""));
  if (Number.isFinite(direct)) {
    return direct;
  }

  const match = normalized.match(/-?\d+(\.\d+)?/);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

export function toIsoTimestamp(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  const timestamp = value < 1_000_000_000_000 ? value * 1000 : value;
  return new Date(timestamp).toISOString();
}

export function resolveResetAtFromWindow(
  window: Record<string, unknown> | undefined,
): string | undefined {
  if (!window) {
    return undefined;
  }

  const resetAt = readNumber(window.reset_at);
  if (resetAt !== undefined) {
    return new Date(resetAt * 1000).toISOString();
  }

  const resetAfterSeconds = readNumber(window.reset_after_seconds);
  if (resetAfterSeconds !== undefined) {
    return new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
  }

  return undefined;
}
