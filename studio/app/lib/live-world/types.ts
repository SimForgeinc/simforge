import type { TruthFrame } from '@simforge/training-env';

export type WorldSourceStatus = 'idle' | 'connecting' | 'running' | 'error' | 'closed';

export interface SpawnActorRequest {
  blueprint: string;
  position: { x: number; y: number; z?: number };
  headingRad?: number;
  speedMps?: number;
  controlled?: boolean;
}

export interface ControlInput {
  actorId: string;
  steer: number;
  throttle: number;
  brake: number;
  reverse?: boolean;
}

export interface WorldSource {
  readonly status: WorldSourceStatus;
  readonly lastError: string | null;
  subscribeFrames(fn: (frame: TruthFrame) => void): () => void;
  subscribeStatus(fn: (status: WorldSourceStatus, error: string | null) => void): () => void;
  spawn(req: SpawnActorRequest): Promise<{ actorId: string }>;
  despawn(actorId: string): Promise<void>;
  control(input: ControlInput): void;
  close(): void;
}
