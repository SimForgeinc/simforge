/**
 * @simforge/training-env — Gymnasium-semantics environment core over the
 * UniScenarios fixed-step engine, plus the versioned causal ground-truth
 * channel used by the faithfulness-supervision program (rl-plan Phase 1).
 */

export { EnvSession } from './session.js';
export type {
  EnvSessionOptions,
  ResolvedEpisode,
  SettledInputProvider,
  StepInfo,
  StepResult,
} from './session.js';

export { BevRasterBuilder, ObjectListBuilder, StateVectorBuilder, STATE_VECTOR_SIZE } from './observations.js';
export type { BevRaster as BevRasterData } from './types.js';
export type { ObservationContextInput, ObservationFrame } from './observations.js';

export {
  CAUSAL_CHANNEL_VERSION,
  CausalChannelCollector,
  CONFLICT_GENESIS_DISTANCE_M,
  CONFLICT_GENESIS_TTC_S,
  parseCausalChannel,
  serializeCausalChannel,
} from './causal.js';
export type {
  CausalChannel,
  CausalConflictGenesis,
  CausalFrame,
  CausalLosTransition,
  CausalTriggerRecord,
} from './causal.js';

export { assembleReward } from './reward.js';
export type { RewardContext, RewardOutcome, RewardTerms } from './reward.js';

export { DEFAULT_BEV_CONFIG, DEFAULT_OBSERVATION_CONFIG, DEFAULT_REWARD_CONFIG } from './types.js';
export type {
  BevConfig,
  EpisodeConfig,
  EnvAction,
  Observation,
  ObservationConfig,
  PerceivedObject,
  RewardConfig,
} from './types.js';
