import type { JsonValue } from "./json-schema.js";

export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const nextItem = toJsonValue(item);
      if (nextItem === undefined) {
        return undefined;
      }
      items.push(nextItem);
    }
    return items;
  }

  if (value !== null && typeof value === "object") {
    const record: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const nextItem = toJsonValue(item);
      if (nextItem === undefined) {
        return undefined;
      }
      record[key] = nextItem;
    }
    return record;
  }

  return undefined;
}
