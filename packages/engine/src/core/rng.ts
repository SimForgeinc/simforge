/**
 * Seeded PRNG. The engine core is deterministic and does not *need* randomness,
 * but jitter-style behaviours (driver reaction spread, sampled dynamics) draw
 * from here so that every stochastic element is reproducible from the seed.
 *
 * `Math.random` is banned in this package — see `determinism.test.ts`.
 */

/** SplitMix32: expands a single integer seed into well-mixed 32-bit words. */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** FNV-1a over UTF-16 code units — used to fold string seeds into 32 bits. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Normalise the public `seed` field (number | string) to a 32-bit integer. */
export function normalizeSeed(seed: number | string): number {
  if (typeof seed === 'number') {
    return Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) >>> 0 : 0;
  }
  return seedFromString(seed);
}

/** xoshiro128** — small state, good equidistribution, integer-exact. */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number | string) {
    const next = splitmix32(normalizeSeed(seed) || 0x9e3779b9);
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
  }

  /** Next raw 32-bit unsigned integer. */
  nextUint32(): number {
    const t1 = Math.imul(this.s1, 5);
    const result = (Math.imul((t1 << 7) | (t1 >>> 25), 9) >>> 0) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    this.s0 >>>= 0;
    this.s1 >>>= 0;
    return result;
  }

  /** Uniform in `[0, 1)`. */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform in `[lo, hi)`. */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** A child stream keyed by a label — independent of draw order on `this`. */
  fork(label: string): Rng {
    return new Rng((this.s0 ^ seedFromString(label)) >>> 0);
  }
}
