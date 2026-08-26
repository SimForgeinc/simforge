/**
 * Browser-safe entry point.
 *
 * The package root (`./index.ts`) is not importable from a browser bundle:
 * `policy-session.ts` imports runtime values from `env-server.ts`, which pulls
 * `node:net`, `node:fs/promises`, `node:zlib` and `node:crypto`. Type-only
 * imports of `env-server` elsewhere are erased and harmless; that one value
 * import is not.
 *
 * This entry exposes the subset a browser needs to run and observe a world:
 * `WorldSession` plus the frozen truth-stream wire. Everything reachable from
 * here is platform-neutral — hashing comes from `@simforge/engine`'s pure-TS
 * SHA-256 (`packages/engine/src/core/hash.ts`), deliberately not `node:crypto`
 * or `SubtleCrypto`, so digests are identical and synchronous on both runtimes.
 *
 * Keep it that way: adding an export here that reaches a Node builtin breaks
 * every browser consumer at bundle time, not at run time.
 */

export {
  WorldSession,
  replayWorldSessionLog,
  WORLD_SESSION_LOG_VERSION,
} from './world-session.js';
export type {
  AdvanceResult,
  SpawnRequest,
  WorldCommand,
  WorldCommandResult,
  WorldSessionLog,
  WorldSessionOptions,
  WorldSessionSnapshot,
} from './world-session.js';

export {
  WorldTruthPublisher,
  TruthStreamClient,
  encodeTruthFrame,
  WORLD_TRUTH_QUEUE_CAPACITY,
} from './truth-stream.js';
export type {
  TruthActor,
  TruthActorCatalogEntry,
  TruthFrame,
  TruthSubscription,
  TruthSubscriptionStats,
} from './truth-stream.js';
