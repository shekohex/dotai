import path from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const SessionQueryToolDetailsSchema = Type.Object(
  {
    question: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export function parseSessionQueryToolDetails(details: unknown): { question?: string } | undefined {
  if (!Value.Check(SessionQueryToolDetailsSchema, details)) {
    return undefined;
  }
  return Value.Parse(SessionQueryToolDetailsSchema, details);
}

export function extractSessionUuid(sessionPath: string): string {
  if (!sessionPath) return "...";
  const filename = path.basename(sessionPath, ".jsonl");
  const separatorIndex = filename.indexOf("_");
  if (separatorIndex === -1) return filename;
  const uuid = filename.slice(separatorIndex + 1);
  return uuid.length >= 8 ? uuid.slice(0, 8) : uuid;
}

export function truncateQuestion(question: string, maxLength = 60): string {
  if (question.length <= maxLength) return question;
  return `${question.slice(0, maxLength - 1).trimEnd()}…`;
}

export function countRenderedLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split("\n").filter((line) => line.length > 0).length;
}
