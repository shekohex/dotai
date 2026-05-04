export function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isNonEmptyString(value: string | undefined | null): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function hasStringProperty<K extends string>(
  value: unknown,
  property: K,
): value is Record<K, string> {
  return isNonNullObject(value) && typeof value[property] === "string";
}
