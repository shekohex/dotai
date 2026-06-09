import { Value } from "typebox/value";
import type { TObject, Static } from "typebox";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { asRecord } from "../../../utils/unknown-data.js";

type FrontmatterResult<TSchema extends TObject> = {
  frontmatter: Static<TSchema>;
  body: string;
};

export function parseMarkdownFrontmatter<TSchema extends TObject>(
  content: string,
  schema: TSchema,
): FrontmatterResult<TSchema> {
  const normalized = content.replaceAll(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("Missing frontmatter");
  }

  const lines = normalized.split("\n");
  let closingLine = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") {
      closingLine = index;
      break;
    }
  }
  if (closingLine === -1) {
    throw new Error("Unterminated frontmatter");
  }

  let parsed: unknown;
  let body: string;
  try {
    const result = parseFrontmatter(normalized);
    parsed = result.frontmatter;
    body = result.body;
  } catch (error) {
    throw new Error(`Invalid frontmatter: ${error instanceof Error ? error.message : "unknown"}`, {
      cause: error,
    });
  }

  const candidate = asRecord(parsed);
  if (candidate === undefined) {
    throw new Error("Invalid frontmatter: must be object");
  }

  for (const key of Object.keys(candidate)) {
    if (candidate[key] === null && propertyAcceptsString(schema, key)) {
      candidate[key] = "";
      continue;
    }
    if (
      propertyAcceptsString(schema, key) &&
      (typeof candidate[key] === "number" || typeof candidate[key] === "boolean")
    ) {
      candidate[key] = String(candidate[key]);
    }
  }

  if (!Value.Check(schema, candidate)) {
    const first = [...Value.Errors(schema, candidate)][0];
    throw new Error(`Invalid frontmatter: ${first?.message ?? "unknown"}`);
  }

  return { frontmatter: candidate, body };
}

export function readLooseKeyValueSection(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase().replaceAll(/\s+/g, "_");
    const value = line.slice(separator + 1).trim();
    if (value.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

function propertyAcceptsString(schema: TObject, key: string): boolean {
  const properties = asRecord(schema.properties);
  const propertySchema = properties?.[key];
  if (propertySchema === undefined) {
    return false;
  }
  return schemaNodeAcceptsString(propertySchema);
}

function schemaNodeAcceptsString(value: unknown): boolean {
  const node = asRecord(value);
  if (node === undefined) {
    return false;
  }
  if (node.type === "string") {
    return true;
  }
  const variants = Array.isArray(node.anyOf) ? node.anyOf : undefined;
  if (variants === undefined) {
    return false;
  }
  return variants.some((variant) => schemaNodeAcceptsString(variant));
}
