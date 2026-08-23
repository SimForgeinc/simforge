/**
 * ULID minting.
 *
 * ULIDs rather than UUIDs because entity ids show up in serialized diffs and in
 * the undo log: lexicographic order equals creation order, which makes both
 * readable. 26 chars, Crockford base32, uppercase — 48 bits of millisecond
 * timestamp followed by 80 bits of randomness.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Canonical ULID form. {@link newId} always produces ids matching this. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function encodeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0 || ms > 0xffffffffffff) {
    throw new RangeError(`newId: timestamp ${ms} is out of ULID range`);
  }
  let rest = Math.floor(ms);
  let out = '';
  for (let i = 0; i < TIME_LEN; i++) {
    out = CROCKFORD[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/**
 * Mint a fresh entity id.
 *
 * @param now Milliseconds since the epoch. Injectable so tests can pin it.
 * @param random Byte source. Injectable so tests can make ids deterministic.
 * @returns A 26-character uppercase ULID.
 *
 * @example
 * ```ts
 * const id = newId(); // "01K1B2Q3ZC7YP4M5N6R7S8T9VA"
 * ```
 */
export function newId(now: number = Date.now(), random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(RANDOM_LEN);
  let out = encodeTime(now);
  for (let i = 0; i < RANDOM_LEN; i++) out += CROCKFORD[(bytes[i] ?? 0) % 32];
  return out;
}

/**
 * A counter-backed id factory for tests and fixtures.
 *
 * @param prefix Leading characters; the counter is zero-padded after it.
 * @returns A function that yields `prefix0001`, `prefix0002`, ...
 */
export function sequentialIds(prefix = 'E'): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(4, '0')}`;
}
