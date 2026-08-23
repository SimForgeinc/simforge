/**
 * Pure utility functions for parsing, simplifying, and inspecting JSON property trees.
 * Used by the JsonTreeView component and testable independently.
 *
 * Key behaviors:
 * - Parses stringified JSON values (common in GeoJSON/MapLibre properties)
 * - Strips XODR-style braced UUIDs: {xxxx-...} → xxxx-...
 * - Flattens single-key {Id: "uuid"} objects → just the UUID string
 * - Flattens arrays of {Id: "..."} objects → flat UUID arrays
 */

/** Regex matching a UUID wrapped in curly braces (XODR convention). */
export const BRACED_UUID_RE = /^\{([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\}$/i;

/** Regex detecting a UUID-like string (with or without braces). */
export const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-/i;

/**
 * Recursively clean parsed JSON:
 * 1. Strip braced UUIDs: {xxxx-...} → xxxx-...
 * 2. Flatten single-key ID objects: {Id: "xxxx"} → "xxxx"
 * 3. Flatten arrays of single-key ID objects: [{Id:"a"},{Id:"b"}] → ["a","b"]
 */
export function simplifyParsed(value: unknown): unknown {
  if (typeof value === "string") {
    const m = BRACED_UUID_RE.exec(value);
    return m ? m[1]! : value;
  }
  if (Array.isArray(value)) {
    const simplified = value.map(simplifyParsed);
    // Flatten arrays where every item is a single-key {Id: "..."} object → flat UUID list
    if (
      simplified.length > 0 &&
      simplified.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          Object.keys(item).length === 1 &&
          "Id" in item,
      )
    ) {
      return simplified.map((item) => (item as Record<string, unknown>).Id);
    }
    return simplified;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    // Flatten single-key {Id: "uuid"} objects → just the UUID string
    if (keys.length === 1 && keys[0] === "Id") {
      const inner = simplifyParsed((value as Record<string, unknown>).Id);
      if (typeof inner === "string") return inner;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = simplifyParsed(v);
    }
    return out;
  }
  return value;
}

/**
 * Try to parse stringified JSON (common in GeoJSON / MapLibre properties),
 * then simplify the result (strip braced UUIDs, flatten ID objects).
 * Returns the original value if not parseable.
 */
export function tryParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const s = value.trim();
  if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
    try {
      return simplifyParsed(JSON.parse(s));
    } catch {
      // Not valid JSON — might be a single braced UUID
      const m = BRACED_UUID_RE.exec(s);
      return m ? m[1]! : value;
    }
  }
  return value;
}

/** Count of child entries (object keys or array items). Returns 0 for primitives. */
export function childCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object" && value !== null) return Object.keys(value).length;
  return 0;
}

/** Summarize a value for collapsed preview display. */
export function collapsedPreview(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length} item${value.length !== 1 ? "s" : ""}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    if (keys.length <= 3) return `{ ${keys.join(", ")} }`;
    return `{ ${keys.slice(0, 2).join(", ")}, … ${keys.length} keys }`;
  }
  return String(value);
}

/** Check if a value is "simple" (primitive or empty collection). */
export function isSimple(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return true;
  if (Array.isArray(value)) return value.length === 0;
  return Object.keys(value).length === 0;
}
