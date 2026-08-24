/**
 * Shared JSON-parsing helpers for db store files.
 *
 * Each function is parameterised so callers can reproduce their existing
 * fallback semantics exactly.
 */

/**
 * Parse a JSON column value and return the result, or `fallback` on any
 * failure.  Both `null`/`undefined` inputs and the literal string `"null"`
 * are treated as missing and return `fallback`.
 *
 * Accepts `string | null` input (the common DB column type).
 */
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value || value === "null") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Variant that also accepts an already-parsed object (Postgres drivers
 * sometimes return the object directly).  Non-string, non-null values are
 * returned as-is after a cast.
 */
export function parseJsonPassThrough<T>(
  value: string | T | null | undefined,
  fallback: T,
): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  if (value === "null") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Parse a JSON column into an array, returning `[]` on any failure.
 * Verifies the parsed value is actually an array.
 */
export function parseJsonArray<T>(value: string | null | undefined): T[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

/**
 * Parse a JSON column into a `Record<string, unknown>`, returning `{}`  on
 * any failure (including when the parsed value is an array or primitive).
 * Also accepts an already-parsed object.
 */
export function parseJsonObject(
  value: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  if (value === "null") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Parse a JSON column into a `Record<string, unknown>` or `null`.
 * Returns `null` on any failure including arrays.
 * Also accepts an already-parsed object.
 */
export function parseJsonRecord(
  value: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
