/**
 * The one height path every overlay builder uses.
 *
 * Draping is the same problem for lanes, signal poles and crosswalk rings: take
 * a scene XZ, ask the host for the ground height there, and decide what to do
 * when the host cannot answer. Each builder used to answer that last question
 * its own way — `buildLaneOverlay` silently substituted `defaultHeight`,
 * `buildSignalOverlay` silently substituted the Y baked into the feature — which
 * meant a caller whose sampler had a hole got a lane pinned to y = 0 in one
 * layer and a floating signal in the other, with nothing in either result
 * saying so.
 *
 * {@link createHeightResolver} is that decision, made once and made explicit:
 *
 * - `'default'` (the historical behaviour) — substitute `defaultHeight`, or the
 *   feature's own baked height when the caller supplied no default.
 * - `'skip'` — drop the feature. The builders count what they dropped, so a
 *   sampler with holes shows up in `userData` instead of as geometry in the
 *   wrong place.
 * - `'throw'` — fail loudly with the offending coordinate. For pipelines where
 *   a missing height is a bug in the caller's index, not in the data.
 *
 * A sampler that is simply absent is not a "miss": with no sampler at all every
 * feature takes the default, exactly as before.
 */

/**
 * Ground-height lookup in scene space (metres, y-up).
 *
 * Return `null` or `undefined` where the height is unknown — `GroundIndex.sample`
 * and `CityViewer.sampleGroundHeight` both already do.
 */
export type HeightSampler = (x: number, z: number) => number | null | undefined;

/** What a builder does when {@link HeightSampler} cannot answer. */
export type MissingHeightPolicy = 'default' | 'skip' | 'throw';

/** Height options shared by every overlay builder. */
export interface HeightOptions {
  /** Per-vertex ground height. Without one, everything takes `defaultHeight`. */
  heightSampler?: HeightSampler;
  /**
   * Scene Y used when there is no sampler, or when the sampler misses and
   * `onMissingHeight` is `'default'`. Defaults per builder (lanes: `0`;
   * signals: the height baked into the feature).
   */
  defaultHeight?: number;
  /** What to do when the sampler misses. Default `'default'`. */
  onMissingHeight?: MissingHeightPolicy;
}

/** Thrown by a resolver built with `onMissingHeight: 'throw'`. */
export class MissingHeightError extends Error {
  readonly x: number;
  readonly z: number;

  constructor(x: number, z: number) {
    super(`no ground height at scene (${x.toFixed(3)}, ${z.toFixed(3)})`);
    this.name = 'MissingHeightError';
    this.x = x;
    this.z = z;
  }
}

/**
 * Resolve a scene Y for one XZ.
 *
 * @param baked A per-feature fallback (e.g. the Y the loader projected), used
 *   when the caller supplied no `defaultHeight`.
 * @returns The height, or `null` when the policy is `'skip'` and the sampler
 *   missed.
 */
export type HeightResolver = (x: number, z: number, baked?: number) => number | null;

/** Build the resolver described in the module docs. */
export function createHeightResolver(options: HeightOptions = {}): HeightResolver {
  const { heightSampler, defaultHeight, onMissingHeight = 'default' } = options;
  return (x, z, baked) => {
    if (heightSampler) {
      const sampled = heightSampler(x, z);
      if (sampled !== null && sampled !== undefined && Number.isFinite(sampled)) return sampled;
      if (onMissingHeight === 'skip') return null;
      if (onMissingHeight === 'throw') throw new MissingHeightError(x, z);
    }
    return defaultHeight ?? baked ?? 0;
  };
}
