/**
 * Locale-independent string ordering.
 *
 * `String.prototype.localeCompare` is ICU-backed: it ignores punctuation
 * weight, collates digits by locale rules, and can differ between Node builds
 * and platforms. Using it to sort ids would make the "same sources ⇒ same
 * bytes" contract quietly platform-dependent — the emitted array order would
 * change under a different `LANG`. Every identity-bearing sort in this package
 * goes through {@link compareStrings}, which is plain UTF-16 code-unit order,
 * i.e. exactly what `Array.prototype.sort()` does by default.
 */

/** UTF-16 code-unit comparison. Locale- and platform-independent. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Comparator over a string-valued key. */
export function byString<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => compareStrings(key(a), key(b));
}
