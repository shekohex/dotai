import { readFile } from "node:fs/promises";
import { errorMessage } from "../../../utils/error-message.js";
import {
  asRecord,
  readDeepNumber,
  readDeepString,
  readNumber,
  readString,
} from "../../../utils/unknown-data.js";

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
  const message = errorMessage(error);
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
