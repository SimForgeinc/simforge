import type { ControlInput, SpawnActorRequest } from './types';

export type LiveWorldWorkerRequest =
  | { type: 'init'; mapManifestUrl: string; laneGraphUrl?: string; tickHz: number }
  | { type: 'spawn'; requestId: number; request: SpawnActorRequest }
  | { type: 'despawn'; requestId: number; actorId: string }
  | { type: 'control'; input: ControlInput }
  | { type: 'close' };

export type LiveWorldWorkerResponse =
  | { type: 'ready' }
  | { type: 'frame'; bytes: ArrayBuffer }
  | { type: 'result'; requestId: number; actorId?: string }
  | { type: 'error'; message: string; requestId?: number }
  | { type: 'warning'; message: string };
