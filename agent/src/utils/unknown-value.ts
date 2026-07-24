/**
 * Checks whether an unknown boundary value is a non-array object.
 *
 * @param {unknown} value Boundary value.
 * @returns {boolean} Whether the value is a record.
 */
export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a non-empty string from an unknown boundary value.
 *
 * @param {unknown} value Boundary value.
 * @returns {string | undefined} Non-empty string when present.
 */
export function readUnknownString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parses JSON while preserving the result as unknown.
 *
 * @param {string} value JSON text.
 * @returns {unknown} Parsed boundary value.
 */
export function parseUnknownJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
