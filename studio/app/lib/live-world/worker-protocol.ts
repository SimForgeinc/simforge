import type { SimScenarioInput } from '@simforge-oss/engine';

import type { ControlInput, SpawnActorRequest } from './types';

export type LiveWorldWorkerRequest =
  | { type: 'init'; mapManifestUrl: string; laneGraphUrl?: string; tickHz: number }
  | { type: 'init-authored'; input: SimScenarioInput; laneGraphUrl: string; tickHz: number }
  | { type: 'spawn'; requestId: number; request: SpawnActorRequest }
  | { type: 'despawn'; requestId: number; actorId: string }
  | { type: 'set-ego'; actorId: string | null }
  | { type: 'control'; input: ControlInput }
  | {
      type: 'transport';
      action: 'play' | 'stop' | 'reset' | 'playPause' | 'seek' | 'exitInspection';
      seconds?: number;
    }
  | { type: 'close' };

export type LiveWorldWorkerResponse =
  | { type: 'ready' }
  | { type: 'frame'; bytes: ArrayBuffer }
  | { type: 'transport'; playing: boolean; inspecting: boolean; completed: boolean; time: number; duration: number }
  | { type: 'result'; requestId: number; actorId?: string }
  | { type: 'error'; message: string; requestId?: number }
  | { type: 'warning'; message: string };
