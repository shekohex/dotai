import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const TOOL_STATE_ENTRY_TYPE = "tool-state";

const ToolStateEntrySchema = Type.Object(
  {
    version: Type.Literal(1),
    key: Type.String(),
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

type ToolStateEntry = Static<typeof ToolStateEntrySchema>;
type SessionEntryLike = { type: string; customType?: string; data?: unknown };

function isSessionEntryArray(
  entries: Iterable<SessionEntryLike>,
): entries is readonly SessionEntryLike[] {
  return Array.isArray(entries);
}

export function createToolStateEntry(key: string, enabled: boolean): ToolStateEntry {
  return { version: 1, key, enabled };
}

function readToolStateEntry(entry: SessionEntryLike, key: string): boolean | null {
  if (entry.type !== "custom" || entry.customType !== TOOL_STATE_ENTRY_TYPE) {
    return null;
  }
  if (!Value.Check(ToolStateEntrySchema, entry.data)) {
    return null;
  }
  const data = Value.Parse(ToolStateEntrySchema, entry.data);
  return data.key === key ? data.enabled : null;
}

export function readToolState(entries: Iterable<SessionEntryLike>, key: string): boolean | null {
  if (isSessionEntryArray(entries)) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) {
        continue;
      }
      const enabled = readToolStateEntry(entry, key);
      if (enabled !== null) {
        return enabled;
      }
    }
    return null;
  }

  let enabled: boolean | null = null;
  for (const entry of entries) {
    const parsed = readToolStateEntry(entry, key);
    if (parsed !== null) {
      enabled = parsed;
    }
  }
  return enabled;
}
