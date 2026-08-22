/**
 * The examiner's real-trace corpus contract.
 *
 * One scenario record binds together everything a deterministic checker needs
 * to judge a claim against engine ground truth:
 *
 * - `tracks` — true per-decision actor poses, lanes and presence, decimated
 *   from an engine trace to the decision grid;
 * - `causalChannel` — the versioned rl-env causal ground-truth channel
 *   (`CausalChannel`), i.e. LOS transitions, trigger causality and conflict
 *   genesis;
 * - `interactions` — the authored interaction list, which is what makes
 *   *intent* propositions checkable rather than vibes.
 *
 * Both passes come from the same byte-deterministic engine over one
 * materialized instance; see `tools/build-corpus.ts`.
 */

import type { CausalChannel } from '@uniscenarios/rl-env';
import type { Interaction } from '@uniscenarios/sim-engine';

export interface DecimatedTrack {
  readonly t: number[];
  readonly x: number[];
  readonly y: number[];
  readonly headingRad: number[];
  readonly speedMps: number[];
  /** RSL lane id per decision tick ('' while absent). */
  readonly laneRsl: string[];
  /** 0/1 presence per decision tick. */
  readonly present: number[];
}

export interface CorpusScenario {
  readonly id: string;
  readonly templatePath: string;
  readonly mapId: string;
  readonly siteId: string;
  readonly seed: string;
  readonly traceDigest: string;
  readonly egoId: string;
  readonly decisionHz: number;
  readonly clipSeconds: number;
  /** Non-ego actor kinds by id. */
  readonly actorKinds: Record<string, string>;
  /** Authored interactions — the intent ground truth. */
  readonly interactions: readonly Interaction[];
  readonly tracks: Record<string, DecimatedTrack>;
  readonly causalChannel: CausalChannel;
}

export interface Corpus {
  readonly corpusVersion: number;
  readonly generator: string;
  readonly scenarios: readonly CorpusScenario[];
}
