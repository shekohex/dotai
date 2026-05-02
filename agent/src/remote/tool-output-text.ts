import { Type } from "typebox";
import { Value } from "typebox/value";
import { JsonValueSchema, type JsonValue } from "./json-schema.js";

const ToolOutputTextShapeSchema = Type.Object({
  content: Type.Tuple([
    Type.Object({
      type: Type.Literal("text"),
      text: Type.String(),
    }),
  ]),
  details: Type.Optional(JsonValueSchema),
});

type ToolOutputTextShape = {
  content: [{ type: "text"; text: string }];
  details?: JsonValue;
};

export type ToolPartialPatchOperation =
  | { op: "replace"; path: Array<string | number>; value: JsonValue }
  | { op: "remove"; path: Array<string | number> }
  | { op: "append_text"; path: Array<string | number>; start: number; delta: string };

export function readToolOutputText(value: JsonValue | undefined): string | undefined {
  if (!Value.Check(ToolOutputTextShapeSchema, value)) {
    return undefined;
  }

  return value.content[0].text;
}

export function appendToolOutputTextDelta(
  value: JsonValue | undefined,
  delta: string,
): ToolOutputTextShape | undefined {
  if (!Value.Check(ToolOutputTextShapeSchema, value)) {
    return undefined;
  }

  return {
    ...value,
    content: [{ ...value.content[0], text: `${value.content[0].text}${delta}` }],
  };
}

export function diffToolPartialResult(
  previous: JsonValue | undefined,
  next: JsonValue,
): ToolPartialPatchOperation[] | undefined {
  if (previous === undefined) {
    return undefined;
  }

  const operations = diffJsonValue([], previous, next);
  return operations.length > 0 ? operations : undefined;
}

export function applyToolPartialPatch(
  value: JsonValue | undefined,
  operations: ToolPartialPatchOperation[],
): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  let nextValue: JsonValue | undefined = structuredClone(value);
  for (const operation of operations) {
    nextValue = applyToolPartialPatchOperation(nextValue, operation);
    if (nextValue === undefined) {
      return undefined;
    }
  }

  return nextValue;
}

function diffJsonValue(
  path: Array<string | number>,
  previous: JsonValue,
  next: JsonValue,
): ToolPartialPatchOperation[] {
  if (JSON.stringify(previous) === JSON.stringify(next)) {
    return [];
  }

  if (typeof previous === "string" && typeof next === "string" && next.startsWith(previous)) {
    return [
      { op: "append_text", path, start: previous.length, delta: next.slice(previous.length) },
    ];
  }

  if (Array.isArray(previous) && Array.isArray(next)) {
    if (previous.length !== next.length) {
      return [{ op: "replace", path, value: next }];
    }

    return previous.flatMap((previousItem, index) =>
      diffJsonValue([...path, index], previousItem, next[index]),
    );
  }

  if (isJsonObject(previous) && isJsonObject(next)) {
    const operations: ToolPartialPatchOperation[] = [];
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const key of keys) {
      if (!(key in next)) {
        operations.push({ op: "remove", path: [...path, key] });
        continue;
      }
      if (!(key in previous)) {
        operations.push({ op: "replace", path: [...path, key], value: next[key] });
        continue;
      }
      operations.push(...diffJsonValue([...path, key], previous[key], next[key]));
    }
    return operations;
  }

  return [{ op: "replace", path, value: next }];
}

function applyToolPartialPatchOperation(
  value: JsonValue,
  operation: ToolPartialPatchOperation,
): JsonValue | undefined {
  if (operation.path.length === 0) {
    if (operation.op === "replace") {
      return structuredClone(operation.value);
    }
    if (operation.op === "append_text") {
      return typeof value === "string" && value.length === operation.start
        ? `${value}${operation.delta}`
        : undefined;
    }
    return undefined;
  }

  const [head, ...tail] = operation.path;
  if (Array.isArray(value)) {
    if (typeof head !== "number") {
      return undefined;
    }

    const nextValue = [...value];
    if (tail.length === 0) {
      if (operation.op === "remove") {
        nextValue.splice(head, 1);
        return nextValue;
      }
      if (operation.op === "replace") {
        nextValue[head] = structuredClone(operation.value);
        return nextValue;
      }
      const currentValue = nextValue[head];
      if (typeof currentValue !== "string" || currentValue.length !== operation.start) {
        return undefined;
      }
      nextValue[head] = `${currentValue}${operation.delta}`;
      return nextValue;
    }

    const currentValue = nextValue[head];
    if (currentValue === undefined) {
      return undefined;
    }
    const nestedValue = applyToolPartialPatchOperation(currentValue, { ...operation, path: tail });
    if (nestedValue === undefined) {
      return undefined;
    }
    nextValue[head] = nestedValue;
    return nextValue;
  }

  if (!isJsonObject(value) || typeof head !== "string") {
    return undefined;
  }

  const nextValue: Record<string, JsonValue> = { ...value };
  if (tail.length === 0) {
    if (operation.op === "remove") {
      delete nextValue[head];
      return nextValue;
    }
    if (operation.op === "replace") {
      nextValue[head] = structuredClone(operation.value);
      return nextValue;
    }
    const currentValue = nextValue[head];
    if (typeof currentValue !== "string" || currentValue.length !== operation.start) {
      return undefined;
    }
    nextValue[head] = `${currentValue}${operation.delta}`;
    return nextValue;
  }

  const currentValue = nextValue[head];
  if (currentValue === undefined) {
    return undefined;
  }
  const nestedValue = applyToolPartialPatchOperation(currentValue, { ...operation, path: tail });
  if (nestedValue === undefined) {
    return undefined;
  }
  nextValue[head] = nestedValue;
  return nextValue;
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
